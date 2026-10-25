using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.Text;
using System.Threading;
using System.Windows.Automation;

namespace Encode.Desktop
{
    /// <summary>A screenshot the model was given: enough to turn a pixel of it back into a pixel of the screen, and to notice that the window has moved since.</summary>
    internal sealed class CaptureRecord
    {
        public string Id;
        public string WindowId;
        public Box WindowBox;
        public Box Box;
        public double Scale;
    }

    /// <summary>What a window looked like the last time anyone looked, to tell whether it has changed.</summary>
    internal sealed class LookMemory
    {
        public Frame Frame;
        public int Stamp;
        public string Signature;
        public Box WindowBox;
        public string Title;
    }

    internal sealed class LookOptions
    {
        public string Image = "false";
        public bool Outline;
        public int MaxElements = 300;
        public int MaxImageEdge = Geo.MaxImageEdge;
        public int MaxImagePixels = Geo.MaxImagePixels;
        public string ZoomCapture;
        public Box ZoomBox;
        public int SettleMs;
    }

    /// <summary>The desktop as the contract describes it. One instance serves every request, one at a time.</summary>
    internal sealed partial class Session
    {
        public const string Version = "1";
        private const int MaxCaptures = 64;
        private const int MaxMemories = 6;

        private readonly WindowTable windows = new WindowTable();
        private readonly UiaService uia = new UiaService();
        private readonly InputService input = new InputService();
        private readonly Dictionary<string, CaptureRecord> captures = new Dictionary<string, CaptureRecord>();
        private readonly Queue<string> captureOrder = new Queue<string>();
        private readonly Dictionary<string, LookMemory> memory = new Dictionary<string, LookMemory>();
        private int memoryClock;
        private int captureCounter;

        public object Handle(string op, Dictionary<string, object> args, Cancel cancel)
        {
            switch (op)
            {
                case "ready": return Ready(args);
                case "windows": return ListWindows();
                case "focus": return Focus(args, cancel);
                case "look": return Look(args, cancel);
                case "act": return Act(args, cancel);
                case "cursor": return CursorAt();
                case "apps": return Apps(cancel);
                case "open": return Open(args, cancel);
                default: throw new HelperException("failed", "Unknown request: " + op);
            }
        }

        public void Shutdown()
        {
            try { input.ReleaseAll(); } catch (Exception) { }
        }

        // ---------------------------------------------------------------- ready, windows, cursor

        private object Ready(Dictionary<string, object> args)
        {
            List<uint> pids = new List<uint>();
            List<object> given = Args.Arr(args, "ownPids");
            if (given != null) foreach (object item in given) if (item is long && (long)item > 0) pids.Add((uint)(long)item);
            windows.Configure(pids, Args.Strings(args, "ownPaths"), Args.Bool(args, "allowElevated", false), Args.Int(args, "firstWindow", 1));
            if (!input.DesktopAvailable()) throw new HelperException("unavailable", "The screen is locked or the session is disconnected, so there is no desktop to use.");
            // Touch UI Automation once, so that a missing component is found here and not in the middle of a task.
            try
            {
                Worker.Run<bool>(delegate() { return AutomationElement.RootElement != null; }, 15000, "UI Automation", null);
            }
            catch (HelperException error)
            {
                throw new HelperException("unavailable", "UI Automation is not available: " + error.Message);
            }
            Dictionary<string, object> info = new Dictionary<string, object>();
            info["platform"] = "win32";
            info["version"] = Version;
            info["scale"] = Screens.ScalePercent();
            List<object> monitors = new List<object>();
            foreach (Box monitor in Screens.Monitors()) monitors.Add(monitor.ToJson());
            info["monitors"] = monitors;
            info["watching"] = true;
            return info;
        }

        private object ListWindows()
        {
            List<object> list = new List<object>();
            foreach (WindowRecord record in windows.List()) list.Add(record.ToJson());
            return list;
        }

        private object CursorAt()
        {
            POINT point = input.Cursor();
            return new object[] { point.X, point.Y };
        }

        // ---------------------------------------------------------------- windows

        private WindowRecord Resolve(string id, List<string> allowed)
        {
            WindowRecord record = windows.Find(id);
            if (record == null) throw new HelperException("window-gone", "Window " + id + " is gone.");
            if (record.Blocked != null) throw new HelperException("refused", record.Label + " cannot be used: " + record.Blocked + ".");
            if (!allowed.Contains(record.App)) throw new HelperException("not-allowed", record.App + " is not allowed for this call.");
            return record;
        }

        private static string Describe(ElementEntry entry)
        {
            string name = entry.Name == null ? "" : entry.Name.Replace('"', '\'');
            if (name.Length > 50) name = name.Substring(0, 49) + "...";
            return entry.Ref + " " + (entry.Role ?? "element") + (name.Length > 0 ? " \"" + name + "\"" : "");
        }

        /// <summary>Whether the keyboard goes to the window: it is in front, or a dialog or menu of it is.</summary>
        private static bool InFront(IntPtr hwnd)
        {
            return WindowTable.Belongs(Native.GetForegroundWindow(), hwnd);
        }

        /// <summary>Brings the window to the front. Windows lets only the program in front do that, so this borrows its input queue for the moment it takes.</summary>
        private void Raise(WindowRecord window, Cancel cancel)
        {
            IntPtr hwnd = window.Hwnd;
            if (Native.IsIconic(hwnd))
            {
                Native.ShowWindow(hwnd, Const.SW_RESTORE);
                for (int n = 0; n < 20 && Native.IsIconic(hwnd); n++) Cancel.Sleep(cancel, 40);
            }
            for (int attempt = 0; attempt < 3 && !InFront(hwnd); attempt++)
            {
                IntPtr front = Native.GetForegroundWindow();
                uint me = Native.GetCurrentThreadId();
                uint ignored;
                uint frontThread = front == IntPtr.Zero ? 0 : Native.GetWindowThreadProcessId(front, out ignored);
                uint targetThread = Native.GetWindowThreadProcessId(hwnd, out ignored);
                bool attachedFront = frontThread != 0 && frontThread != me && Native.AttachThreadInput(me, frontThread, true);
                bool attachedTarget = targetThread != 0 && targetThread != me && targetThread != frontThread && Native.AttachThreadInput(me, targetThread, true);
                try
                {
                    Native.BringWindowToTop(hwnd);
                    Native.SetForegroundWindow(hwnd);
                }
                finally
                {
                    if (attachedTarget) Native.AttachThreadInput(me, targetThread, false);
                    if (attachedFront) Native.AttachThreadInput(me, frontThread, false);
                }
                Cancel.Sleep(cancel, 70);
            }
            if (!InFront(hwnd))
            {
                Native.SwitchToThisWindow(hwnd, true);
                Cancel.Sleep(cancel, 120);
            }
            if (!InFront(hwnd)) throw new HelperException("failed", "Windows did not let eNCode bring " + window.Id + " to the front. Click its title bar, or ask the user to.");
        }

        private object Focus(Dictionary<string, object> args, Cancel cancel)
        {
            WindowRecord window = Resolve(Args.Str(args, "window", null), Args.Strings(args, "allowed"));
            Raise(window, cancel);
            Cancel.Sleep(cancel, 80);
            WindowRecord fresh = windows.Find(window.Id) ?? window;
            Dictionary<string, object> json = fresh.ToJson();
            json["foreground"] = true;
            return json;
        }

        /// <summary>A minimized window cannot be seen. Show it again where it was, without taking the focus from what the user is doing.</summary>
        private WindowRecord Restore(WindowRecord window, Cancel cancel)
        {
            Native.ShowWindow(window.Hwnd, Const.SW_SHOWNOACTIVATE);
            for (int n = 0; n < 15 && Native.IsIconic(window.Hwnd); n++) Cancel.Sleep(cancel, 40);
            if (Native.IsIconic(window.Hwnd))
            {
                Native.ShowWindow(window.Hwnd, Const.SW_RESTORE);
                for (int n = 0; n < 15 && Native.IsIconic(window.Hwnd); n++) Cancel.Sleep(cancel, 40);
            }
            Cancel.Sleep(cancel, 150);
            WindowRecord fresh = windows.Find(window.Id);
            if (fresh == null) throw new HelperException("window-gone", "Window " + window.Id + " is gone.");
            return fresh;
        }

        // ---------------------------------------------------------------- looking

        private static int Clamp(int value, int low, int high)
        {
            return Math.Max(low, Math.Min(high, value));
        }

        private static LookOptions ParseLook(Dictionary<string, object> map)
        {
            LookOptions options = new LookOptions();
            object image = Args.Get(map, "image");
            if (image is bool) options.Image = (bool)image ? "true" : "false";
            else if (image as string == "changed") options.Image = "changed";
            object outline = Args.Get(map, "outline");
            options.Outline = outline != null && outline as string != "none";
            options.MaxElements = Clamp(Args.Int(map, "maxElements", 300), 1, 3000);
            options.MaxImageEdge = Clamp(Args.Int(map, "maxImageEdge", Geo.MaxImageEdge), 64, 4096);
            options.MaxImagePixels = Clamp(Args.Int(map, "maxImagePixels", Geo.MaxImagePixels), 4096, 8000000);
            options.SettleMs = Clamp(Args.Int(map, "settleMs", 0), 0, 10000);
            Dictionary<string, object> zoom = Args.Obj(Args.Get(map, "zoom"));
            if (zoom != null)
            {
                options.ZoomCapture = Args.Str(zoom, "capture", null);
                options.ZoomBox = Box.FromJson(Args.Get(zoom, "box"));
            }
            return options;
        }

        private object Look(Dictionary<string, object> args, Cancel cancel)
        {
            WindowRecord window = Resolve(Args.Str(args, "window", null), Args.Strings(args, "allowed"));
            LookOptions options = ParseLook(args);
            bool stable = true;
            if (options.SettleMs > 0 && window.State != "minimized") stable = Settle(window, options.SettleMs, cancel);
            WindowRecord current = windows.Find(window.Id);
            if (current == null) throw new HelperException("window-gone", "Window " + window.Id + " is gone.");
            return BuildLook(current, options, stable, cancel);
        }

        /// <summary>Everything in front of the window that belongs to another program: the model never sees it, and a click never lands there.</summary>
        private List<Box> OverlapMasks(WindowRecord window, Box shot)
        {
            List<Box> masks = new List<Box>();
            uint ownerPid = WindowTable.PidOf(window.Hwnd);
            foreach (IntPtr hwnd in windows.TopLevel())
            {
                if (hwnd == window.Hwnd) break;
                if (!Native.IsWindowVisible(hwnd) || Native.IsIconic(hwnd) || WindowTable.IsCloaked(hwnd)) continue;
                if (WindowTable.PidOf(hwnd) == ownerPid || WindowTable.IsOwnedBy(hwnd, window.Hwnd)) continue;
                uint style = WindowTable.ExStyle(hwnd);
                if ((style & Const.WS_EX_TRANSPARENT) != 0) continue;
                if ((style & Const.WS_EX_LAYERED) != 0)
                {
                    uint key;
                    byte alpha;
                    uint flags;
                    if (Native.GetLayeredWindowAttributes(hwnd, out key, out alpha, out flags) && (flags & Const.LWA_ALPHA) != 0 && alpha < 16) continue;
                }
                Box covered = WindowTable.BoxOf(hwnd).Intersect(shot);
                if (!covered.IsEmpty) masks.Add(covered);
            }
            return masks;
        }

        private static string Hash(string text)
        {
            ulong hash = 14695981039346656037UL;
            foreach (char c in text)
            {
                hash ^= c;
                hash *= 1099511628211UL;
            }
            return hash.ToString("x16", CultureInfo.InvariantCulture);
        }

        private static string Signature(OutlineResult outline)
        {
            StringBuilder sb = new StringBuilder();
            foreach (OutlineEntry entry in outline.Entries)
            {
                NodeInfo node = entry.Node;
                sb.Append(node.Role).Append('|').Append(node.Name).Append('|').Append(node.Value).Append('|').Append(string.Join(",", node.States)).Append('\n');
            }
            return Hash(sb.ToString());
        }

        private Dictionary<string, object> BuildLook(WindowRecord window, LookOptions options, bool stable, Cancel cancel)
        {
            WindowRecord w = window.State == "minimized" ? Restore(window, cancel) : window;
            Box area = w.Box.Intersect(Screens.Virtual());
            if (area.IsEmpty) throw new HelperException("failed", "The window is outside the screen. Use focus to bring it back.");

            bool zoom = options.ZoomCapture != null;
            Box shot = area;
            if (zoom)
            {
                CaptureRecord source;
                if (!captures.TryGetValue(options.ZoomCapture, out source) || source.WindowId != w.Id) throw new HelperException("stale-capture", "Capture " + options.ZoomCapture + " is unknown.");
                if (!source.WindowBox.Same(w.Box)) throw new HelperException("stale-capture", w.Id + " moved or changed size since screenshot " + source.Id + ".");
                Box region = new Box(
                    source.Box.X + Geo.Round(options.ZoomBox.X / source.Scale),
                    source.Box.Y + Geo.Round(options.ZoomBox.Y / source.Scale),
                    Geo.Round(options.ZoomBox.W / source.Scale),
                    Geo.Round(options.ZoomBox.H / source.Scale));
                shot = region.Intersect(source.Box);
                if (shot.IsEmpty) throw new HelperException("failed", "The region is outside the screenshot.");
            }

            OutlineResult outline = null;
            if (options.Outline)
            {
                OutlineLimits limits = new OutlineLimits();
                limits.MaxEntries = options.MaxElements;
                outline = uia.Outline(w, limits, cancel);
            }
            List<Box> masks = OverlapMasks(w, shot);
            List<Box> passwords = outline != null ? outline.Passwords : (zoom || options.Image != "false" ? uia.PasswordBoxes(w, cancel) : new List<Box>());
            foreach (Box password in passwords)
            {
                Box covered = password.Intersect(shot);
                if (!covered.IsEmpty) masks.Add(covered);
            }

            int imageWidth;
            int imageHeight;
            double scale;
            Geo.FitImage(shot.W, shot.H, options.MaxImageEdge, options.MaxImagePixels, out imageWidth, out imageHeight, out scale);

            bool changed = false;
            string data = null;
            string mediaType = "image/png";
            using (Bitmap bitmap = Imaging.Grab(shot))
            {
                Imaging.Paint(bitmap, shot, masks);
                if (!zoom)
                {
                    Frame frame = Imaging.Sample(bitmap, 1);
                    LookMemory previous;
                    memory.TryGetValue(w.Id, out previous);
                    string signature = outline != null ? Signature(outline) : (previous != null ? previous.Signature : null);
                    changed = previous == null
                        || !previous.WindowBox.Same(w.Box)
                        || previous.Title != w.Title
                        || (outline != null && previous.Signature != signature)
                        || Frames.Differs(previous.Frame, frame);
                    LookMemory next = new LookMemory();
                    next.Frame = frame;
                    next.Stamp = ++memoryClock;
                    next.Signature = signature;
                    next.WindowBox = w.Box;
                    next.Title = w.Title;
                    memory[w.Id] = next;
                    Forget();
                }
                if (options.Image == "true" || (options.Image == "changed" && changed) || zoom) data = Imaging.Encode(bitmap, imageWidth, imageHeight, out mediaType);
            }

            string id = "s" + (++captureCounter).ToString(CultureInfo.InvariantCulture);
            if (!zoom)
            {
                CaptureRecord record = new CaptureRecord();
                record.Id = id;
                record.WindowId = w.Id;
                record.WindowBox = w.Box;
                record.Box = shot;
                record.Scale = scale;
                captures[id] = record;
                captureOrder.Enqueue(id);
                while (captureOrder.Count > MaxCaptures) captures.Remove(captureOrder.Dequeue());
            }

            Dictionary<string, object> capture = new Dictionary<string, object>();
            capture["id"] = id;
            capture["box"] = shot.ToJson();
            capture["width"] = imageWidth;
            capture["height"] = imageHeight;
            capture["scale"] = scale;
            capture["mediaType"] = mediaType;
            if (data != null) capture["data"] = data;
            capture["masked"] = masks.Count;

            List<object> related = new List<object>();
            foreach (WindowRecord other in windows.List())
            {
                if (other.Id != w.Id && other.App == w.App && other.Blocked == null) related.Add(other.ToJson());
            }

            Dictionary<string, object> look = new Dictionary<string, object>();
            look["window"] = w.ToJson();
            look["related"] = related;
            look["capture"] = capture;
            if (outline != null) look["outline"] = OutlineJson(outline);
            look["changed"] = changed;
            look["stable"] = stable;
            return look;
        }

        private Dictionary<string, object> OutlineJson(OutlineResult outline)
        {
            List<object> elements = new List<object>();
            string focused = null;
            foreach (OutlineEntry entry in outline.Entries)
            {
                NodeInfo node = entry.Node;
                string reference = uia.RefOf(node);
                if (reference == null) continue;
                Dictionary<string, object> element = new Dictionary<string, object>();
                element["ref"] = reference;
                element["role"] = node.Role;
                element["name"] = node.Name;
                if (node.Value != null) element["value"] = node.Value;
                element["depth"] = entry.Depth;
                element["box"] = node.Box.ToJson();
                element["states"] = node.States;
                element["can"] = node.Can;
                elements.Add(element);
                if (focused == null && node.Focused) focused = reference;
            }
            Dictionary<string, object> json = new Dictionary<string, object>();
            json["elements"] = elements;
            json["total"] = Math.Max(outline.Total, elements.Count);
            if (focused != null) json["focused"] = focused;
            return json;
        }

        /// <summary>A picture of each window is kept to tell whether it changed; only the windows looked at most recently keep theirs.</summary>
        private void Forget()
        {
            while (memory.Count > MaxMemories)
            {
                string oldest = null;
                int stamp = int.MaxValue;
                foreach (KeyValuePair<string, LookMemory> pair in memory)
                {
                    if (pair.Value.Stamp < stamp)
                    {
                        stamp = pair.Value.Stamp;
                        oldest = pair.Key;
                    }
                }
                memory.Remove(oldest);
            }
        }

        /// <summary>Waits until the window stops changing: the picture is the same on consecutive looks. False when the time ran out first.</summary>
        private bool Settle(WindowRecord window, int maxMs, Cancel cancel)
        {
            Stopwatch clock = Stopwatch.StartNew();
            Frame previous = null;
            Box previousBox = window.Box;
            int same = 0;
            Cancel.Sleep(cancel, Math.Min(60, maxMs));
            while (true)
            {
                WindowRecord now = windows.Find(window.Id);
                if (now == null || now.State == "minimized") return true;
                Box area = now.Box.Intersect(Screens.Virtual());
                if (area.IsEmpty) return true;
                Frame frame;
                using (Bitmap bitmap = Imaging.Grab(area))
                {
                    Imaging.Paint(bitmap, area, OverlapMasks(now, area));
                    frame = Imaging.Sample(bitmap, 2);
                }
                bool unchanged = previous != null && now.Box.Same(previousBox) && !Frames.Differs(previous, frame);
                same = unchanged ? same + 1 : 0;
                if (same >= 2) return true;
                if (clock.ElapsedMilliseconds >= maxMs) return false;
                previous = frame;
                previousBox = now.Box;
                Cancel.Sleep(cancel, 70);
            }
        }
    }
}
