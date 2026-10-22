using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Encode.Desktop
{
    internal sealed class ProcessInfo
    {
        public uint Pid;
        public string Path = "";
        public string App = "unknown";
        public string Label = "";
        /// <summary>Runs as administrator, or its rights could not be read: either way input to it is not ours to send.</summary>
        public bool Elevated;
        /// <summary>Part of eNCode itself.</summary>
        public bool Own;
        public long CheckedAt;
    }

    internal sealed class WindowRecord
    {
        public IntPtr Hwnd;
        public string Id;
        /// <summary>The program's process; for a Store app, the hosted app and not the frame that shows it.</summary>
        public uint Pid;
        public string App = "unknown";
        public string Label = "";
        public string Title = "";
        public string ClassName = "";
        public Box Box;
        public string State = "normal";
        public bool Foreground;
        public string Blocked;
        public IntPtr Owner;

        public Dictionary<string, object> ToJson()
        {
            Dictionary<string, object> map = new Dictionary<string, object>();
            map["id"] = Id;
            map["app"] = App;
            map["label"] = Label;
            map["title"] = Title;
            map["pid"] = (long)Pid;
            map["box"] = Box.ToJson();
            map["state"] = State;
            map["foreground"] = Foreground;
            if (Blocked != null) map["blocked"] = Blocked;
            return map;
        }
    }

    /// <summary>
    /// The top-level windows of the desktop as the contract names them: stable ids (w1, w2), the program a
    /// window belongs to, and the reasons a window can never be used. Everything that asks "is this window
    /// the one the call is about" goes through here.
    /// </summary>
    internal sealed class WindowTable
    {
        private const long ProcessTtlMs = 10000;

        private sealed class Known
        {
            public IntPtr Hwnd;
            public uint Pid;
        }

        private readonly Dictionary<string, Known> byId = new Dictionary<string, Known>();
        private readonly Dictionary<long, string> idOf = new Dictionary<long, string>();
        private readonly Dictionary<uint, ProcessInfo> processes = new Dictionary<uint, ProcessInfo>();
        private readonly Dictionary<string, string> labels = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        private readonly HashSet<uint> ownPids = new HashSet<uint>();
        private readonly HashSet<string> ownPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private int counter;

        public bool AllowElevated;

        public void Configure(IEnumerable<uint> pids, IEnumerable<string> paths, bool allowElevated, int firstWindow)
        {
            // After a restart the numbers go on from where the last helper stopped: an old id must never name another window.
            if (firstWindow - 1 > counter) counter = firstWindow - 1;
            ownPids.Clear();
            ownPaths.Clear();
            foreach (uint pid in pids) ownPids.Add(pid);
            ownPids.Add((uint)Process.GetCurrentProcess().Id);
            foreach (string path in paths) if (!string.IsNullOrEmpty(path)) ownPaths.Add(path);
            AllowElevated = allowElevated;
            processes.Clear();
        }

        // ---------------------------------------------------------------- small questions about one window

        public static string ClassOf(IntPtr hwnd)
        {
            StringBuilder sb = new StringBuilder(256);
            return Native.GetClassName(hwnd, sb, sb.Capacity) > 0 ? sb.ToString() : "";
        }

        public static string TitleOf(IntPtr hwnd)
        {
            int length = Native.GetWindowTextLength(hwnd);
            if (length <= 0) return "";
            StringBuilder sb = new StringBuilder(Math.Min(length, 1000) + 1);
            Native.GetWindowText(hwnd, sb, sb.Capacity);
            string title = sb.ToString();
            return title.Length > 300 ? title.Substring(0, 300) : title;
        }

        public static bool IsCloaked(IntPtr hwnd)
        {
            int cloaked;
            return Native.DwmGetWindowAttribute(hwnd, Const.DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0;
        }

        public static uint ExStyle(IntPtr hwnd)
        {
            return unchecked((uint)Native.GetWindowLong(hwnd, Const.GWL_EXSTYLE));
        }

        public static uint PidOf(IntPtr hwnd)
        {
            uint pid;
            Native.GetWindowThreadProcessId(hwnd, out pid);
            return pid;
        }

        /// <summary>The window as the user sees it: without the invisible resize borders Windows adds around a frame.</summary>
        public static Box BoxOf(IntPtr hwnd)
        {
            if (Native.IsIconic(hwnd))
            {
                WINDOWPLACEMENT placement = new WINDOWPLACEMENT();
                placement.length = (uint)Marshal.SizeOf(typeof(WINDOWPLACEMENT));
                if (Native.GetWindowPlacement(hwnd, ref placement)) return Native.RectToBox(placement.rcNormalPosition);
            }
            RECT frame;
            if (Native.DwmGetWindowAttribute(hwnd, Const.DWMWA_EXTENDED_FRAME_BOUNDS, out frame, Marshal.SizeOf(typeof(RECT))) == 0) return Native.RectToBox(frame);
            RECT rect;
            return Native.GetWindowRect(hwnd, out rect) ? Native.RectToBox(rect) : Box.Empty;
        }

        public static bool IsOwnedBy(IntPtr window, IntPtr ancestor)
        {
            IntPtr current = window;
            for (int depth = 0; depth < 12; depth++)
            {
                current = Native.GetWindow(current, Const.GW_OWNER);
                if (current == IntPtr.Zero) return false;
                if (current == ancestor) return true;
            }
            return false;
        }

        /// <summary>
        /// Whether what a click or a key would reach is the window the call is about: the window, a dialog or
        /// menu it owns, or a popup of its program (a drop-down list, a tooltip). Another window of the same
        /// program is not: the model did not look at it.
        /// </summary>
        public static bool Belongs(IntPtr hit, IntPtr target)
        {
            if (hit == IntPtr.Zero) return false;
            IntPtr root = Native.GetAncestor(hit, Const.GA_ROOT);
            if (root == IntPtr.Zero) root = hit;
            if (root == target || IsOwnedBy(root, target)) return true;
            if (PidOf(root) != PidOf(target)) return false;
            string cls = ClassOf(root);
            if (cls == "#32768" || cls == "ComboLBox" || cls == "tooltips_class32") return true;
            uint ex = ExStyle(root);
            return (ex & (Const.WS_EX_TOOLWINDOW | Const.WS_EX_NOACTIVATE)) != 0 && (ex & Const.WS_EX_APPWINDOW) == 0;
        }

        // ---------------------------------------------------------------- programs

        private static bool IsElevated(IntPtr process)
        {
            IntPtr token;
            if (!Native.OpenProcessToken(process, Const.TOKEN_QUERY, out token)) return true;
            try
            {
                TOKEN_ELEVATION elevation;
                int returned;
                if (!Native.GetTokenInformation(token, Const.TokenElevation, out elevation, Marshal.SizeOf(typeof(TOKEN_ELEVATION)), out returned)) return true;
                return elevation.TokenIsElevated != 0;
            }
            finally
            {
                Native.CloseHandle(token);
            }
        }

        private string LabelFor(string path, string app)
        {
            string label;
            if (path.Length > 0 && labels.TryGetValue(path, out label)) return label;
            label = "";
            if (path.Length > 0)
            {
                try
                {
                    label = (FileVersionInfo.GetVersionInfo(path).FileDescription ?? "").Trim();
                }
                catch (Exception)
                {
                    label = "";
                }
            }
            if (label.Length == 0 || label.Length > 60)
            {
                string bare = app.EndsWith(".exe", StringComparison.Ordinal) ? app.Substring(0, app.Length - 4) : app;
                label = bare.Length == 0 ? "Program" : char.ToUpperInvariant(bare[0]) + bare.Substring(1);
            }
            if (path.Length > 0) labels[path] = label;
            return label;
        }

        private ProcessInfo Proc(uint pid)
        {
            ProcessInfo info;
            long now = Stopwatch.GetTimestamp() / (Stopwatch.Frequency / 1000);
            if (processes.TryGetValue(pid, out info) && now - info.CheckedAt < ProcessTtlMs) return info;
            if (processes.Count > 400) processes.Clear();
            info = new ProcessInfo();
            info.Pid = pid;
            info.CheckedAt = now;
            IntPtr handle = Native.OpenProcess(Const.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (handle == IntPtr.Zero)
            {
                info.Elevated = true;
            }
            else
            {
                try
                {
                    StringBuilder sb = new StringBuilder(1024);
                    uint size = (uint)sb.Capacity;
                    if (Native.QueryFullProcessImageName(handle, 0, sb, ref size)) info.Path = sb.ToString();
                    info.Elevated = IsElevated(handle);
                }
                finally
                {
                    Native.CloseHandle(handle);
                }
            }
            if (info.Path.Length > 0) info.App = System.IO.Path.GetFileName(info.Path).ToLowerInvariant();
            info.Own = ownPids.Contains(pid) || (info.Path.Length > 0 && ownPaths.Contains(info.Path));
            info.Label = LabelFor(info.Path, info.App);
            processes[pid] = info;
            return info;
        }

        /// <summary>A Store app's frame window belongs to a host program; the app itself runs in a window inside it.</summary>
        private static uint HostedPid(IntPtr frame, uint hostPid)
        {
            uint found = 0;
            EnumWindowsProc callback = delegate(IntPtr child, IntPtr lParam)
            {
                uint pid = PidOf(child);
                if (pid != hostPid && ClassOf(child) == "Windows.UI.Core.CoreWindow")
                {
                    found = pid;
                    return false;
                }
                return true;
            };
            Native.EnumChildWindows(frame, callback, IntPtr.Zero);
            GC.KeepAlive(callback);
            return found != 0 ? found : hostPid;
        }

        private static readonly HashSet<string> ShellPrograms = new HashSet<string>
        {
            "startmenuexperiencehost.exe", "searchhost.exe", "searchapp.exe", "shellexperiencehost.exe", "shellhost.exe", "lockapp.exe"
        };

        private static bool IsShellWindow(string app, string cls, string title)
        {
            if (cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd" || cls == "NotifyIconOverflowWindow" || cls == "TopLevelWindowForOverflowXamlIsland") return true;
            if (ShellPrograms.Contains(app)) return true;
            return app == "explorer.exe" && cls == "#32770" && string.Equals(title, "Run", StringComparison.OrdinalIgnoreCase);
        }

        // ---------------------------------------------------------------- windows

        private string IdFor(IntPtr hwnd, uint pid)
        {
            long key = hwnd.ToInt64();
            string id;
            Known known;
            if (idOf.TryGetValue(key, out id) && byId.TryGetValue(id, out known) && known.Pid == pid) return id;
            id = "w" + (++counter).ToString(System.Globalization.CultureInfo.InvariantCulture);
            idOf[key] = id;
            Known entry = new Known();
            entry.Hwnd = hwnd;
            entry.Pid = pid;
            byId[id] = entry;
            return id;
        }

        /// <summary>The window as it is now, or null when it is gone. With `listing`, also null for windows nobody would call a window (helper windows, tooltips, overlays).</summary>
        public WindowRecord Describe(IntPtr hwnd, IntPtr foreground, bool listing)
        {
            if (hwnd == IntPtr.Zero || !Native.IsWindow(hwnd)) return null;
            if (!Native.IsWindowVisible(hwnd) || IsCloaked(hwnd)) return null;
            string cls = ClassOf(hwnd);
            if (cls == "Progman" || cls == "WorkerW") return null;
            uint ex = ExStyle(hwnd);
            IntPtr owner = Native.GetWindow(hwnd, Const.GW_OWNER);
            string title = TitleOf(hwnd);
            bool menu = cls == "#32768";
            bool tray = cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd";
            if (listing && !tray)
            {
                bool tool = (ex & Const.WS_EX_TOOLWINDOW) != 0;
                bool appWindow = (ex & Const.WS_EX_APPWINDOW) != 0;
                if (tool && !appWindow && !menu && (owner == IntPtr.Zero || title.Length == 0)) return null;
                if (!tool && !appWindow && !menu && owner == IntPtr.Zero && title.Length == 0) return null;
                if ((ex & Const.WS_EX_NOACTIVATE) != 0 && !menu && title.Length == 0) return null;
                if ((ex & Const.WS_EX_TRANSPARENT) != 0 && !appWindow) return null;
            }
            Box box = BoxOf(hwnd);
            if (box.IsEmpty || (listing && box.W < 8 && box.H < 8)) return null;

            uint pid = PidOf(hwnd);
            uint appPid = cls == "ApplicationFrameWindow" ? HostedPid(hwnd, pid) : pid;
            ProcessInfo proc = Proc(appPid);
            WindowRecord rec = new WindowRecord();
            rec.Hwnd = hwnd;
            rec.Pid = appPid;
            rec.Id = IdFor(hwnd, pid);
            rec.ClassName = cls;
            rec.Owner = owner;
            rec.Title = menu && title.Length == 0 ? "Menu" : title;
            rec.Box = box;
            rec.State = Native.IsIconic(hwnd) ? "minimized" : Native.IsZoomed(hwnd) ? "maximized" : "normal";
            rec.Foreground = hwnd == foreground || (foreground != IntPtr.Zero && Native.GetAncestor(foreground, Const.GA_ROOTOWNER) == hwnd);
            if (IsShellWindow(proc.App, cls, title))
            {
                rec.App = "shell";
                rec.Label = "Windows shell";
            }
            else
            {
                rec.App = proc.App;
                rec.Label = proc.Label;
            }
            if (proc.Own) rec.Blocked = "it is eNCode's own window";
            else if (proc.Elevated && !AllowElevated) rec.Blocked = "it runs as administrator, and eNCode cannot send input to it";
            return rec;
        }

        public List<IntPtr> TopLevel()
        {
            List<IntPtr> list = new List<IntPtr>();
            EnumWindowsProc callback = delegate(IntPtr hwnd, IntPtr lParam)
            {
                list.Add(hwnd);
                return true;
            };
            Native.EnumWindows(callback, IntPtr.Zero);
            GC.KeepAlive(callback);
            return list;
        }

        /// <summary>The windows on the desktop, front to back.</summary>
        public List<WindowRecord> List()
        {
            List<WindowRecord> result = new List<WindowRecord>();
            IntPtr foreground = Native.GetForegroundWindow();
            foreach (IntPtr hwnd in TopLevel())
            {
                WindowRecord rec = Describe(hwnd, foreground, true);
                if (rec != null) result.Add(rec);
            }
            Forget();
            return result;
        }

        /// <summary>Drops the ids of windows that no longer exist.</summary>
        private void Forget()
        {
            List<string> gone = new List<string>();
            foreach (KeyValuePair<string, Known> pair in byId)
            {
                if (!Native.IsWindow(pair.Value.Hwnd) || PidOf(pair.Value.Hwnd) != pair.Value.Pid) gone.Add(pair.Key);
            }
            foreach (string id in gone)
            {
                idOf.Remove(byId[id].Hwnd.ToInt64());
                byId.Remove(id);
            }
        }

        /// <summary>The window an id names, as it is now; null when it is gone.</summary>
        public WindowRecord Find(string id)
        {
            Known known;
            if (id == null || !byId.TryGetValue(id, out known)) return null;
            if (!Native.IsWindow(known.Hwnd) || PidOf(known.Hwnd) != known.Pid) return null;
            return Describe(known.Hwnd, Native.GetForegroundWindow(), false);
        }

        public bool Exists(string id)
        {
            Known known;
            return id != null && byId.TryGetValue(id, out known) && Native.IsWindow(known.Hwnd) && PidOf(known.Hwnd) == known.Pid;
        }
    }

    /// <summary>The monitors, and what the screen is scaled by.</summary>
    internal static class Screens
    {
        public static Box Virtual()
        {
            return new Box(
                Native.GetSystemMetrics(Const.SM_XVIRTUALSCREEN),
                Native.GetSystemMetrics(Const.SM_YVIRTUALSCREEN),
                Native.GetSystemMetrics(Const.SM_CXVIRTUALSCREEN),
                Native.GetSystemMetrics(Const.SM_CYVIRTUALSCREEN));
        }

        public static List<Box> Monitors()
        {
            List<Box> list = new List<Box>();
            MonitorEnumProc callback = delegate(IntPtr monitor, IntPtr dc, ref RECT rect, IntPtr data)
            {
                list.Add(Native.RectToBox(rect));
                return true;
            };
            Native.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
            GC.KeepAlive(callback);
            return list;
        }

        /// <summary>The primary display's scaling in percent: 100, 125, 150.</summary>
        public static int ScalePercent()
        {
            try
            {
                uint dpi = Native.GetDpiForSystem();
                return dpi == 0 ? 100 : (int)Math.Round(dpi * 100.0 / 96.0);
            }
            catch (EntryPointNotFoundException)
            {
                return 100;
            }
        }
    }
}
