using System;
using System.Collections.Generic;
using System.Globalization;

namespace Encode.Desktop
{
    /// <summary>Where an input lands, in screen pixels, and the element it was named by, if it was named by one.</summary>
    internal sealed class Landing
    {
        public int X;
        public int Y;
        public ElementEntry Entry;
        public ElementNow Now;
        /// <summary>The element was out of view and its list scrolled it in first.</summary>
        public bool Scrolled;
        /// <summary>Something else of the window was over the element at every pixel tried (ADR 0121).</summary>
        public bool Covered;
        /// <summary>Windows found the element itself, or a part of it, at the pixel.</summary>
        public bool Inside;
    }

    internal sealed partial class Session
    {
        private const int CursorTolerance = 6;

        private static Dictionary<string, object> Performed(string kind, string via, string detail)
        {
            Dictionary<string, object> done = new Dictionary<string, object>();
            done["kind"] = kind;
            done["via"] = via;
            if (detail != null) done["detail"] = detail;
            return done;
        }

        /// <summary>
        /// An input of the pointer and what it went to (ADR 0121): what Windows found under the pixel, said when the target was a
        /// coordinate (the model learns what it hit) or when it is not the element the model named (something was over it).
        /// </summary>
        private Dictionary<string, object> Pointed(string kind, WindowRecord window, Landing landing, string detail, Cancel cancel)
        {
            List<string> notes = new List<string>();
            if (detail != null) notes.Add(detail);
            if (landing.Scrolled) notes.Add("it was scrolled into view first");
            HitInfo hit = uia.At(landing.X, landing.Y, window.Id, cancel);
            bool named = landing.Entry != null;
            if (named && landing.Covered) notes.Add("something else of the window was over it at every point tried");
            Dictionary<string, object> done = Performed(kind, "mouse", notes.Count > 0 ? string.Join("; ", notes.ToArray()) : null);
            if (hit != null && (!named || landing.Covered || (hit.Ref != null && hit.Ref != landing.Entry.Ref && !landing.Inside)))
            {
                Dictionary<string, object> on = new Dictionary<string, object>();
                if (hit.Ref != null) on["ref"] = hit.Ref;
                on["role"] = hit.Role ?? "element";
                on["name"] = hit.Name ?? "";
                done["on"] = on;
            }
            return done;
        }

        // ---------------------------------------------------------------- act

        private object Act(Dictionary<string, object> args, Cancel cancel)
        {
            List<string> allowed = Args.Strings(args, "allowed");
            WindowRecord window = Resolve(Args.Str(args, "window", null), allowed);
            if (!input.DesktopAvailable()) throw new HelperException("unavailable", "The screen is locked or the session is disconnected, so there is nothing to send input to.");

            int[] expected = Args.Ints(Args.Get(args, "expectCursor"), 2);
            if (expected != null)
            {
                POINT now = input.Cursor();
                if (Math.Abs(expected[0] - now.X) > CursorTolerance || Math.Abs(expected[1] - now.Y) > CursorTolerance) throw new HelperException("interrupted", "The mouse is not where I left it.");
            }

            List<object> steps = Args.Arr(args, "steps") ?? new List<object>();
            bool smooth = Args.Str(args, "pace", "smooth") != "instant";
            int settleMs = Clamp(Args.Int(args, "settleMs", 1200), 0, 10000);
            LookOptions lookOptions = ParseLook(Args.Obj(Args.Get(args, "look")));

            List<WindowRecord> before = windows.List();
            HashSet<long> beforeHandles = new HashSet<long>();
            foreach (WindowRecord record in before) beforeHandles.Add(record.Hwnd.ToInt64());

            List<object> performed = new List<object>();
            input.BeginWatch();
            try
            {
                foreach (object item in steps)
                {
                    Dictionary<string, object> step = Args.Obj(item);
                    if (step == null) throw new HelperException("failed", "A step is not an object.");
                    if (cancel != null) cancel.Check();
                    performed.Add(Perform(window, step, smooth, cancel));
                    input.CheckUser();
                }
            }
            finally
            {
                input.ReleaseAll();
                input.EndWatch();
            }

            bool stable = true;
            if (windows.Exists(window.Id)) stable = Settle(window, settleMs, cancel);

            List<WindowRecord> after = windows.List();
            HashSet<long> afterHandles = new HashSet<long>();
            List<object> opened = new List<object>();
            foreach (WindowRecord record in after)
            {
                afterHandles.Add(record.Hwnd.ToInt64());
                if (!beforeHandles.Contains(record.Hwnd.ToInt64())) opened.Add(record.ToJson());
            }
            List<object> closed = new List<object>();
            foreach (WindowRecord record in before)
            {
                if (afterHandles.Contains(record.Hwnd.ToInt64())) continue;
                closed.Add(record.Id);
                memory.Remove(record.Id);
                uia.ForgetWindow(record.Id);
            }

            Dictionary<string, object> result = new Dictionary<string, object>();
            result["performed"] = performed;
            WindowRecord current = windows.Find(window.Id);
            result["look"] = current != null && afterHandles.Contains(current.Hwnd.ToInt64()) ? BuildLook(current, lookOptions, stable, cancel) : null;
            result["opened"] = opened;
            result["closed"] = closed;
            POINT cursor = input.Cursor();
            result["cursor"] = new object[] { cursor.X, cursor.Y };
            return result;
        }

        // ---------------------------------------------------------------- targets

        /// <summary>Whether what an input at this pixel would reach is the window the call is about.</summary>
        private void Land(WindowRecord window, int x, int y)
        {
            POINT point = new POINT();
            point.X = x;
            point.Y = y;
            IntPtr hit = Native.WindowFromPoint(point);
            if (WindowTable.Belongs(hit, window.Hwnd)) return;
            WindowRecord other = hit == IntPtr.Zero ? null : windows.Describe(Native.GetAncestor(hit, Const.GA_ROOT) == IntPtr.Zero ? hit : Native.GetAncestor(hit, Const.GA_ROOT), Native.GetForegroundWindow(), false);
            if (other == null) throw new HelperException("covered", "Nothing of " + window.Id + " is at (" + x + ", " + y + ").");
            if (other.App == window.App) throw new HelperException("covered", "Another window of " + window.Label + " is on top of (" + x + ", " + y + ").");
            throw new HelperException("covered", other.Label + " is on top of (" + x + ", " + y + ").");
        }

        /// <summary>
        /// Where an input goes. For an element, with `reach`, one out of view is scrolled into view by its list first, and the pixel is
        /// one where Windows finds the element itself, not a tooltip or a pop-up over it (ADR 0121).
        /// </summary>
        private Landing TargetOf(WindowRecord window, Dictionary<string, object> target, bool reach, Cancel cancel)
        {
            if (target == null) throw new HelperException("no-element", "The step has no target.");
            Landing landing = new Landing();
            string reference = Args.Str(target, "element", null);
            if (reference != null)
            {
                ElementEntry entry = uia.Entry(reference, window.Id);
                ElementNow now = uia.Now(entry, cancel);
                landing.Entry = entry;
                if (reach && (now.Offscreen || now.Box.IsEmpty || now.Box.Intersect(window.Box).IsEmpty) && uia.ScrollIntoView(entry, cancel))
                {
                    Cancel.Sleep(cancel, 150);
                    now = uia.Now(entry, cancel);
                    landing.Scrolled = true;
                }
                landing.Now = now;
                if (now.Offscreen || now.Box.IsEmpty) throw new HelperException("failed", Describe(entry) + " is not in view, and its list cannot scroll it into view. Scroll to it, then take a new screenshot.");
                Box visible = now.Box.Intersect(window.Box);
                if (visible.IsEmpty) visible = now.Box;
                Box clickable = uia.ClickableBox(entry, cancel) ?? new Box(visible.CenterX, visible.CenterY, 1, 1);
                landing.X = clickable.X;
                landing.Y = clickable.Y;
                if (!visible.Contains(landing.X, landing.Y)) { landing.X = visible.CenterX; landing.Y = visible.CenterY; }
                if (reach) OnTop(entry, visible, landing, cancel);
                return landing;
            }
            int[] point = Args.Ints(Args.Get(target, "point"), 2);
            string captureId = Args.Str(target, "capture", null);
            CaptureRecord record;
            if (point == null || captureId == null || !captures.TryGetValue(captureId, out record) || record.WindowId != window.Id)
            {
                throw new HelperException("stale-capture", "Screenshot " + captureId + " is unknown. Take a new one.");
            }
            if (!record.WindowBox.Same(window.Box)) throw new HelperException("stale-capture", window.Id + " moved or changed size since screenshot " + captureId + ".");
            Geo.ToScreen(point[0], point[1], record.Box, record.Scale, out landing.X, out landing.Y);
            return landing;
        }

        /// <summary>
        /// Keeps the pixel when Windows finds the element there; else tries the middle and the quarters of its box for one where it
        /// does. When none is found, the first pixel stays and the answer says something was over the element. An application that
        /// does not answer the question leaves the pixel as it was.
        /// </summary>
        private void OnTop(ElementEntry entry, Box visible, Landing landing, Cancel cancel)
        {
            bool? first = uia.Covers(entry, landing.X, landing.Y, cancel);
            if (first != false)
            {
                landing.Inside = first == true;
                return;
            }
            int[] parts = { 50, 25, 75 };
            foreach (int down in parts)
            {
                foreach (int across in parts)
                {
                    int x = visible.X + (int)((long)visible.W * across / 100);
                    int y = visible.Y + (int)((long)visible.H * down / 100);
                    if ((x == landing.X && y == landing.Y) || !visible.Contains(x, y)) continue;
                    if (uia.Covers(entry, x, y, cancel) == true)
                    {
                        landing.X = x;
                        landing.Y = y;
                        landing.Inside = true;
                        return;
                    }
                }
            }
            landing.Covered = true;
        }

        /// <summary>
        /// Before an element is used through its own interface, the pointer travels to it at a person's pace, so whoever watches sees
        /// what is about to be pressed. It never stops the step: an element out of view, or under another window, is used all the same.
        /// The person's own hand on the mouse still stops it, as it stops every input.
        /// </summary>
        private void Show(WindowRecord window, ElementEntry entry, bool smooth, Cancel cancel)
        {
            if (!smooth) return;
            Dictionary<string, object> target = new Dictionary<string, object>();
            target["element"] = entry.Ref;
            try
            {
                input.AssertIdle(false, true);
                Landing landing = TargetOf(window, target, false, cancel);
                Land(window, landing.X, landing.Y);
                input.MoveTo(landing.X, landing.Y, true, cancel);
            }
            catch (HelperException error)
            {
                if (cancel != null && cancel.IsCancelled) throw;
                if (error.Code == "interrupted" || error.Code == "unavailable") throw;
            }
        }

        private Landing Aim(WindowRecord window, Dictionary<string, object> target, bool smooth, Cancel cancel)
        {
            Landing landing = TargetOf(window, target, true, cancel);
            Land(window, landing.X, landing.Y);
            input.MoveTo(landing.X, landing.Y, smooth, cancel);
            // The window under the pointer can change while the pointer travels (a tooltip, a window that came forward): look again where it is.
            Land(window, landing.X, landing.Y);
            return landing;
        }

        // ---------------------------------------------------------------- one step

        private Dictionary<string, object> Perform(WindowRecord window, Dictionary<string, object> step, bool smooth, Cancel cancel)
        {
            string kind = Args.Str(step, "kind", "");
            switch (kind)
            {
                case "click": return Click(window, step, smooth, cancel);
                case "move": return Move(window, step, smooth, cancel);
                case "drag": return Drag(window, step, cancel);
                case "scroll": return Scroll(window, step, smooth, cancel);
                case "type": return TypeText(window, step, smooth, cancel);
                case "key": return PressKeys(window, step, cancel);
                case "set_value": return SetValue(window, step, smooth, cancel);
                case "select": return Select(window, step, smooth, cancel);
                default: throw new HelperException("failed", "Unknown step: " + kind);
            }
        }

        private Dictionary<string, object> Click(WindowRecord window, Dictionary<string, object> step, bool smooth, Cancel cancel)
        {
            Dictionary<string, object> target = Args.Obj(Args.Get(step, "target"));
            string button = Args.Str(step, "button", "left");
            int count = Clamp(Args.Int(step, "count", 1), 1, 3);
            string detail = null;
            string reference = Args.Str(target, "element", null);
            if (reference != null)
            {
                ElementEntry entry = uia.Entry(reference, window.Id);
                ElementNow now = uia.Now(entry, cancel);
                if (!now.Enabled) throw new HelperException("failed", Describe(entry) + " is disabled.");
                if (button == "left" && count == 1 && (now.Invoke || now.Toggle))
                {
                    string how = now.Invoke ? "invoke" : "toggle";
                    Show(window, entry, smooth, cancel);
                    try
                    {
                        uia.Invoke(entry, how, cancel);
                        return Performed("click", how, null);
                    }
                    catch (HelperException error)
                    {
                        // A call that never returns is usually a dialog the click opened from inside the call: the click happened.
                        if (error.Code == "hung") return Performed("click", how, "the application was still busy with it, possibly showing a dialog");
                        if (error.Code != "failed" && error.Code != "stale-element") throw;
                        detail = "its own interface refused (" + error.Message + "), so the mouse was used";
                    }
                }
            }
            input.AssertIdle(false, true);
            Landing landing = Aim(window, target, smooth, cancel);
            Dictionary<string, object> done = Pointed("click", window, landing, detail, cancel);
            input.Click(button, count, cancel);
            return done;
        }

        private Dictionary<string, object> Move(WindowRecord window, Dictionary<string, object> step, bool smooth, Cancel cancel)
        {
            input.AssertIdle(false, true);
            Landing landing = Aim(window, Args.Obj(Args.Get(step, "target")), smooth, cancel);
            return Pointed("move", window, landing, null, cancel);
        }

        private Dictionary<string, object> Drag(WindowRecord window, Dictionary<string, object> step, Cancel cancel)
        {
            Landing from = TargetOf(window, Args.Obj(Args.Get(step, "from")), true, cancel);
            Landing to = TargetOf(window, Args.Obj(Args.Get(step, "to")), true, cancel);
            Land(window, from.X, from.Y);
            Land(window, to.X, to.Y);
            input.AssertIdle(false, true);
            input.MoveTo(from.X, from.Y, true, cancel);
            Land(window, from.X, from.Y);
            Dictionary<string, object> done = Pointed("drag", window, from, null, cancel);
            input.Down("left");
            try
            {
                Cancel.Sleep(cancel, 90);
                input.MoveTo(to.X, to.Y, true, cancel);
                Cancel.Sleep(cancel, 90);
                Land(window, to.X, to.Y);
            }
            finally
            {
                input.Up("left");
            }
            return done;
        }

        private Dictionary<string, object> Scroll(WindowRecord window, Dictionary<string, object> step, bool smooth, Cancel cancel)
        {
            string direction = Args.Str(step, "direction", "down");
            int amount = Clamp(Args.Int(step, "amount", 3), 1, 30);
            Dictionary<string, object> target = Args.Obj(Args.Get(step, "target"));
            input.AssertIdle(false, true);
            Landing aimed = null;
            if (target != null)
            {
                aimed = Aim(window, target, smooth, cancel);
            }
            else
            {
                // The wheel goes to the window under the pointer: if the pointer is somewhere else, put it in the middle of the window.
                POINT at = input.Cursor();
                bool inside = window.Box.Contains(at.X, at.Y);
                if (inside)
                {
                    try { Land(window, at.X, at.Y); } catch (HelperException) { inside = false; }
                }
                if (!inside)
                {
                    Land(window, window.Box.CenterX, window.Box.CenterY);
                    input.MoveTo(window.Box.CenterX, window.Box.CenterY, smooth, cancel);
                }
            }
            bool horizontal = direction == "left" || direction == "right";
            int notches = direction == "up" || direction == "right" ? amount : -amount;
            Dictionary<string, object> done = aimed != null ? Pointed("scroll", window, aimed, null, cancel) : Performed("scroll", "mouse", null);
            input.Wheel(horizontal, notches, cancel);
            return done;
        }

        /// <summary>The keyboard goes to the window in front, and a password field is never typed into.</summary>
        private void PrepareKeyboard(WindowRecord window, Cancel cancel)
        {
            input.AssertIdle(true, false);
            if (!InFront(window.Hwnd)) Raise(window, cancel);
            if (!InFront(window.Hwnd))
            {
                WindowRecord front = windows.Describe(Native.GetForegroundWindow(), Native.GetForegroundWindow(), false);
                throw new HelperException("covered", (front != null ? front.Label : "Another window") + " has the keyboard focus. Use focus to bring " + window.Id + " to the front.");
            }
        }

        private void RefusePassword(Cancel cancel)
        {
            bool password;
            try
            {
                password = uia.FocusIsPassword(cancel);
            }
            catch (HelperException error)
            {
                if (error.Code == "hung" || error.Code == "stale-element" || error.Code == "failed") throw new HelperException("hung", "I could not tell which field has the keyboard focus, so nothing was typed.");
                throw;
            }
            if (password) throw new HelperException("password", "The focused field is a password field.");
        }

        private Dictionary<string, object> TypeText(WindowRecord window, Dictionary<string, object> step, bool smooth, Cancel cancel)
        {
            string text = Args.Str(step, "text", "");
            Dictionary<string, object> target = Args.Obj(Args.Get(step, "target"));
            PrepareKeyboard(window, cancel);
            if (target != null)
            {
                string reference = Args.Str(target, "element", null);
                if (reference != null)
                {
                    ElementEntry entry = uia.Entry(reference, window.Id);
                    ElementNow now = uia.Now(entry, cancel);
                    if (now.Password) throw new HelperException("password", "The focused field is a password field.");
                    if (!now.Enabled) throw new HelperException("failed", Describe(entry) + " is disabled.");
                    bool textual = entry.Role == "edit" || entry.Role == "document" || entry.Role == "combobox";
                    if (!textual && now.CanFocus)
                    {
                        Show(window, entry, smooth, cancel);
                        uia.Focus(entry, cancel);
                    }
                    else
                    {
                        input.AssertIdle(false, true);
                        Aim(window, target, smooth, cancel);
                        input.Click("left", 1, cancel);
                    }
                }
                else
                {
                    input.AssertIdle(false, true);
                    Aim(window, target, smooth, cancel);
                    input.Click("left", 1, cancel);
                }
                Cancel.Sleep(cancel, 60);
            }
            RefusePassword(cancel);
            if (!InFront(window.Hwnd)) throw new HelperException("covered", "Another window took the keyboard focus. Use focus to bring " + window.Id + " to the front.");
            input.Type(text, smooth, cancel);
            return Performed("type", "keys", null);
        }

        private Dictionary<string, object> PressKeys(WindowRecord window, Dictionary<string, object> step, Cancel cancel)
        {
            List<object> combos = Args.Arr(step, "combos");
            if (combos == null || combos.Count == 0) throw new HelperException("failed", "Give the keys to press.");
            PrepareKeyboard(window, cancel);
            bool checkedPassword = false;
            foreach (object item in combos)
            {
                Dictionary<string, object> combo = Args.Obj(item);
                string name = Args.Str(combo, "key", "");
                List<string> modifiers = Args.Strings(combo, "modifiers");
                bool ctrl = modifiers.Contains("ctrl");
                bool alt = modifiers.Contains("alt");
                bool shift = modifiers.Contains("shift");
                KeyCode code;
                if (!Keys.TryGet(name, out code)) throw new HelperException("failed", "\"" + name + "\" is not a key name.");
                string away = Keys.LeavesTheWindow(ctrl, alt, name);
                if (away != null) throw new HelperException("failed", "That combination " + away + ". Use the focus action to change windows.");
                if (!checkedPassword && Keys.Types(name) && !ctrl && !alt)
                {
                    RefusePassword(cancel);
                    checkedPassword = true;
                }
                if (!InFront(window.Hwnd)) throw new HelperException("covered", "Another window took the keyboard focus. Use focus to bring " + window.Id + " to the front.");
                input.Combo(ctrl, alt, shift, code, cancel);
                Cancel.Sleep(cancel, 30);
            }
            return Performed("key", "keys", null);
        }

        private Dictionary<string, object> SetValue(WindowRecord window, Dictionary<string, object> step, bool smooth, Cancel cancel)
        {
            ElementEntry entry = uia.Entry(Args.Str(step, "element", null), window.Id);
            ElementNow now = uia.Now(entry, cancel);
            if (now.Password) throw new HelperException("password", "The field is a password field.");
            if (!now.Enabled) throw new HelperException("failed", Describe(entry) + " is disabled.");
            if (!now.Value && !now.Range) throw new HelperException("failed", Describe(entry) + " cannot be set directly. Click it and type instead.");
            if (now.Value && now.ValueReadOnly) throw new HelperException("failed", Describe(entry) + " is read-only.");
            Show(window, entry, smooth, cancel);
            uia.SetValue(entry, Args.Str(step, "text", ""), cancel);
            return Performed("set_value", "value", null);
        }

        private Dictionary<string, object> Select(WindowRecord window, Dictionary<string, object> step, bool smooth, Cancel cancel)
        {
            ElementEntry entry = uia.Entry(Args.Str(step, "element", null), window.Id);
            ElementNow now = uia.Now(entry, cancel);
            if (!now.Enabled) throw new HelperException("failed", Describe(entry) + " is disabled.");
            if (now.Select || now.Invoke) Show(window, entry, smooth, cancel);
            if (now.Select)
            {
                uia.Invoke(entry, "select", cancel);
                return Performed("select", "select", null);
            }
            if (now.Invoke)
            {
                uia.Invoke(entry, "invoke", cancel);
                return Performed("select", "invoke", "it has no selection interface, so it was invoked");
            }
            Dictionary<string, object> target = new Dictionary<string, object>();
            target["element"] = entry.Ref;
            input.AssertIdle(false, true);
            Aim(window, target, smooth, cancel);
            input.Click("left", 1, cancel);
            return Performed("select", "mouse", "it has no selection interface, so it was clicked");
        }
    }
}
