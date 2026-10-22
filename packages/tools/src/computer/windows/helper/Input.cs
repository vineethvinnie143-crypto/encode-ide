using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace Encode.Desktop
{
    /// <summary>
    /// Tells real input from ours. While the helper acts, low-level hooks see every mouse and keyboard event
    /// before the programs do; an event that Windows did not mark as injected came from the user. The hooks
    /// look at one flag and nothing else: no key, no position and no text is read or kept, and they are
    /// installed only for the duration of an action.
    /// </summary>
    internal sealed class InputWatcher
    {
        private const uint MsgInstall = Const.WM_APP + 1;
        private const uint MsgRemove = Const.WM_APP + 2;

        private Thread thread;
        private uint threadId;
        private readonly ManualResetEvent started = new ManualResetEvent(false);
        private readonly AutoResetEvent acknowledged = new AutoResetEvent(false);
        private IntPtr mouseHook = IntPtr.Zero;
        private IntPtr keyboardHook = IntPtr.Zero;
        private HookProc mouseProc;
        private HookProc keyboardProc;
        private volatile bool touched;

        /// <summary>False when the hooks could not be installed: the cursor check is then the only guard.</summary>
        public bool Active { get; private set; }

        public bool Touched { get { return touched; } }

        private void Loop()
        {
            MSG message;
            Native.PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
            threadId = Native.GetCurrentThreadId();
            mouseProc = MouseHook;
            keyboardProc = KeyboardHook;
            started.Set();
            while (Native.GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
            {
                if (message.message == MsgInstall)
                {
                    Install();
                    acknowledged.Set();
                }
                else if (message.message == MsgRemove)
                {
                    Remove();
                    acknowledged.Set();
                }
            }
        }

        private void Install()
        {
            IntPtr module = Native.GetModuleHandle(null);
            if (mouseHook == IntPtr.Zero) mouseHook = Native.SetWindowsHookEx(Const.WH_MOUSE_LL, mouseProc, module, 0);
            if (keyboardHook == IntPtr.Zero) keyboardHook = Native.SetWindowsHookEx(Const.WH_KEYBOARD_LL, keyboardProc, module, 0);
            Active = mouseHook != IntPtr.Zero && keyboardHook != IntPtr.Zero;
        }

        private void Remove()
        {
            if (mouseHook != IntPtr.Zero) Native.UnhookWindowsHookEx(mouseHook);
            if (keyboardHook != IntPtr.Zero) Native.UnhookWindowsHookEx(keyboardHook);
            mouseHook = IntPtr.Zero;
            keyboardHook = IntPtr.Zero;
        }

        private IntPtr MouseHook(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0)
            {
                // MSLLHOOKSTRUCT: pt (8 bytes), mouseData (4), flags (4).
                uint flags = unchecked((uint)Marshal.ReadInt32(lParam, 12));
                if ((flags & (Const.LLMHF_INJECTED | Const.LLMHF_LOWER_IL_INJECTED)) == 0) touched = true;
            }
            return Native.CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
        }

        private IntPtr KeyboardHook(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0)
            {
                // KBDLLHOOKSTRUCT: vkCode (4 bytes), scanCode (4), flags (4).
                uint flags = unchecked((uint)Marshal.ReadInt32(lParam, 8));
                if ((flags & (Const.LLKHF_INJECTED | Const.LLKHF_LOWER_IL_INJECTED)) == 0) touched = true;
            }
            return Native.CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
        }

        private bool Post(uint message)
        {
            if (thread == null)
            {
                thread = new Thread(Loop);
                thread.IsBackground = true;
                thread.Name = "encode-input-watch";
                thread.Start();
            }
            if (!started.WaitOne(3000)) return false;
            if (!Native.PostThreadMessage(threadId, message, IntPtr.Zero, IntPtr.Zero)) return false;
            return acknowledged.WaitOne(3000);
        }

        public void Start()
        {
            touched = false;
            if (!Post(MsgInstall)) Active = false;
        }

        public void Stop()
        {
            Post(MsgRemove);
        }
    }

    /// <summary>Sends the mouse and the keyboard. Every call checks first that the user has not taken over.</summary>
    internal sealed class InputService
    {
        private const int DriftTolerance = 5;

        private readonly InputWatcher watcher = new InputWatcher();
        private readonly List<KeyCode> heldKeys = new List<KeyCode>();
        private readonly List<string> heldButtons = new List<string>();

        public bool Watching { get { return watcher.Active; } }

        /// <summary>False when the screen is locked or the session is disconnected: nothing sent now would reach a program.</summary>
        public bool DesktopAvailable()
        {
            IntPtr desktop = Native.OpenInputDesktop(0, false, Const.DESKTOP_SWITCHDESKTOP);
            if (desktop == IntPtr.Zero) return false;
            Native.CloseDesktop(desktop);
            return true;
        }

        public POINT Cursor()
        {
            POINT point;
            Native.GetCursorPos(out point);
            return point;
        }

        // ---------------------------------------------------------------- the user

        public void BeginWatch()
        {
            watcher.Start();
        }

        public void EndWatch()
        {
            watcher.Stop();
        }

        /// <summary>Stops the action when the user has used the mouse or the keyboard since it began.</summary>
        public void CheckUser()
        {
            if (watcher.Touched) throw new HelperException("interrupted", "The user used the mouse or the keyboard.");
        }

        private void CheckDrift(int x, int y)
        {
            CheckUser();
            POINT now = Cursor();
            if (Math.Abs(now.X - x) > DriftTolerance || Math.Abs(now.Y - y) > DriftTolerance)
            {
                throw new HelperException("interrupted", "The mouse is not where I left it.");
            }
        }

        /// <summary>A key or button the user is holding would mix with what is sent: do not start.</summary>
        public void AssertIdle(bool keyboard, bool mouse)
        {
            if (keyboard)
            {
                foreach (int key in new int[] { Const.VK_SHIFT, Const.VK_CONTROL, Const.VK_MENU })
                {
                    if ((Native.GetAsyncKeyState(key) & 0x8000) != 0) throw new HelperException("interrupted", "A modifier key is being held down.");
                }
            }
            if (mouse)
            {
                foreach (int key in new int[] { Const.VK_LBUTTON, Const.VK_RBUTTON, Const.VK_MBUTTON })
                {
                    if ((Native.GetAsyncKeyState(key) & 0x8000) != 0) throw new HelperException("interrupted", "A mouse button is being held down.");
                }
            }
        }

        // ---------------------------------------------------------------- raw input

        private static void Send(INPUT[] inputs)
        {
            if (inputs.Length == 0) return;
            uint sent = Native.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (sent != inputs.Length)
            {
                int error = Marshal.GetLastWin32Error();
                if (error == 5) throw new HelperException("refused", "Windows blocked the input: the application runs with higher rights than eNCode.");
                throw new HelperException("failed", "Windows did not accept the input (error " + error.ToString(System.Globalization.CultureInfo.InvariantCulture) + ").");
            }
        }

        private static INPUT Mouse(uint flags, int dx, int dy, uint data)
        {
            INPUT input = new INPUT();
            input.type = Const.INPUT_MOUSE;
            input.u.mi.dx = dx;
            input.u.mi.dy = dy;
            input.u.mi.mouseData = data;
            input.u.mi.dwFlags = flags;
            return input;
        }

        private static INPUT Key(ushort vk, bool extended, bool up)
        {
            INPUT input = new INPUT();
            input.type = Const.INPUT_KEYBOARD;
            input.u.ki.wVk = vk;
            input.u.ki.wScan = (ushort)Native.MapVirtualKey(vk, 0);
            input.u.ki.dwFlags = (extended ? Const.KEYEVENTF_EXTENDEDKEY : 0u) | (up ? Const.KEYEVENTF_KEYUP : 0u);
            return input;
        }

        private static INPUT Character(char c, bool up)
        {
            INPUT input = new INPUT();
            input.type = Const.INPUT_KEYBOARD;
            input.u.ki.wVk = 0;
            input.u.ki.wScan = c;
            input.u.ki.dwFlags = Const.KEYEVENTF_UNICODE | (up ? Const.KEYEVENTF_KEYUP : 0u);
            return input;
        }

        private static void MoveAbsolute(int x, int y)
        {
            Box screen = Screens.Virtual();
            if (screen.W <= 0 || screen.H <= 0) throw new HelperException("unavailable", "The screen has no size.");
            long nx = ((long)(x - screen.X) * 65536 + screen.W - 1) / screen.W;
            long ny = ((long)(y - screen.Y) * 65536 + screen.H - 1) / screen.H;
            nx = Math.Max(0, Math.Min(65535, nx));
            ny = Math.Max(0, Math.Min(65535, ny));
            Send(new INPUT[] { Mouse(Const.MOUSEEVENTF_MOVE | Const.MOUSEEVENTF_ABSOLUTE | Const.MOUSEEVENTF_VIRTUALDESK, (int)nx, (int)ny, 0) });
        }

        // ---------------------------------------------------------------- the mouse

        /// <summary>Moves the pointer. Smooth: along a short curve at a speed a person can follow. The pointer must end on the pixel asked for.</summary>
        public void MoveTo(int x, int y, bool smooth, Cancel cancel)
        {
            POINT start = Cursor();
            double dx = x - start.X;
            double dy = y - start.Y;
            double distance = Math.Sqrt(dx * dx + dy * dy);
            if (!smooth || distance < 4)
            {
                MoveAbsolute(x, y);
            }
            else
            {
                int steps = (int)Math.Max(6, Math.Min(32, distance / 16));
                double duration = Math.Max(110, Math.Min(380, 90 + distance * 0.22));
                int delay = (int)Math.Max(4, Math.Round(duration / steps));
                double nx = -dy / distance;
                double ny = dx / distance;
                double bow = Math.Min(22, distance * 0.04);
                int lastX = start.X;
                int lastY = start.Y;
                for (int i = 1; i <= steps; i++)
                {
                    if (cancel != null) cancel.Check();
                    CheckDrift(lastX, lastY);
                    double t = (double)i / steps;
                    double e = t * t * (3 - 2 * t);
                    double arc = Math.Sin(Math.PI * e) * bow;
                    int px = i == steps ? x : (int)Math.Round(start.X + dx * e + nx * arc);
                    int py = i == steps ? y : (int)Math.Round(start.Y + dy * e + ny * arc);
                    MoveAbsolute(px, py);
                    lastX = px;
                    lastY = py;
                    if (i < steps) Cancel.Sleep(cancel, delay);
                }
            }
            Arrive(x, y, cancel);
        }

        /// <summary>The move is queued, not done: wait until the pointer is on the pixel, and put it there if the rounding left it a pixel away.</summary>
        private void Arrive(int x, int y, Cancel cancel)
        {
            for (int attempt = 0; attempt < 6; attempt++)
            {
                POINT now = Cursor();
                if (Math.Abs(now.X - x) <= 1 && Math.Abs(now.Y - y) <= 1) return;
                if (attempt == 3) Native.SetCursorPos(x, y);
                Cancel.Sleep(cancel, 12);
            }
            POINT last = Cursor();
            if (Math.Abs(last.X - x) > DriftTolerance || Math.Abs(last.Y - y) > DriftTolerance) throw new HelperException("interrupted", "The mouse is not where I left it.");
        }

        private static uint DownFlag(string button)
        {
            return button == "right" ? Const.MOUSEEVENTF_RIGHTDOWN : button == "middle" ? Const.MOUSEEVENTF_MIDDLEDOWN : Const.MOUSEEVENTF_LEFTDOWN;
        }

        private static uint UpFlag(string button)
        {
            return button == "right" ? Const.MOUSEEVENTF_RIGHTUP : button == "middle" ? Const.MOUSEEVENTF_MIDDLEUP : Const.MOUSEEVENTF_LEFTUP;
        }

        public void Down(string button)
        {
            Send(new INPUT[] { Mouse(DownFlag(button), 0, 0, 0) });
            heldButtons.Add(button);
        }

        public void Up(string button)
        {
            Send(new INPUT[] { Mouse(UpFlag(button), 0, 0, 0) });
            heldButtons.Remove(button);
        }

        public void Click(string button, int count, Cancel cancel)
        {
            POINT at = Cursor();
            for (int n = 0; n < count; n++)
            {
                CheckDrift(at.X, at.Y);
                Down(button);
                Cancel.Sleep(cancel, 32);
                Up(button);
                if (n + 1 < count) Cancel.Sleep(cancel, 60);
            }
        }

        /// <summary>One notch is 120 units of wheel; a positive amount scrolls up or to the right.</summary>
        public void Wheel(bool horizontal, int notches, Cancel cancel)
        {
            POINT at = Cursor();
            int sign = notches < 0 ? -1 : 1;
            for (int n = 0; n < Math.Abs(notches); n++)
            {
                CheckDrift(at.X, at.Y);
                Send(new INPUT[] { Mouse(horizontal ? Const.MOUSEEVENTF_HWHEEL : Const.MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)(sign * 120))) });
                Cancel.Sleep(cancel, 24);
            }
        }

        // ---------------------------------------------------------------- the keyboard

        private void KeyDown(KeyCode key)
        {
            Send(new INPUT[] { Key(key.Vk, key.Extended, false) });
            heldKeys.Add(key);
        }

        private void KeyUp(KeyCode key)
        {
            Send(new INPUT[] { Key(key.Vk, key.Extended, true) });
            heldKeys.Remove(key);
        }

        /// <summary>Types text as characters, not as keys, so it comes out the same on every keyboard layout. A line break is the Enter key and a tab is Tab.</summary>
        public void Type(string text, bool paced, Cancel cancel)
        {
            List<INPUT> batch = new List<INPUT>();
            int characters = 0;
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (c == '\r' || c == '\n')
                {
                    if (c == '\r' && i + 1 < text.Length && text[i + 1] == '\n') i++;
                    batch.Add(Key(0x0D, false, false));
                    batch.Add(Key(0x0D, false, true));
                }
                else if (c == '\t')
                {
                    batch.Add(Key(0x09, false, false));
                    batch.Add(Key(0x09, false, true));
                }
                else
                {
                    batch.Add(Character(c, false));
                    batch.Add(Character(c, true));
                }
                characters++;
                if (characters % 24 == 0 || i == text.Length - 1)
                {
                    CheckUser();
                    if (cancel != null) cancel.Check();
                    Send(batch.ToArray());
                    batch.Clear();
                    if (paced && i < text.Length - 1) Cancel.Sleep(cancel, 7);
                }
            }
        }

        /// <summary>Presses a key with the modifiers held, then lets them all go.</summary>
        public void Combo(bool ctrl, bool alt, bool shift, KeyCode key, Cancel cancel)
        {
            List<KeyCode> modifiers = new List<KeyCode>();
            if (ctrl) modifiers.Add(new KeyCode(Keys.VkControl, false));
            if (alt) modifiers.Add(new KeyCode(Keys.VkMenu, false));
            if (shift) modifiers.Add(new KeyCode(Keys.VkShift, false));
            try
            {
                foreach (KeyCode modifier in modifiers) KeyDown(modifier);
                if (modifiers.Count > 0) Cancel.Sleep(cancel, 12);
                CheckUser();
                KeyDown(key);
                Cancel.Sleep(cancel, 16);
                KeyUp(key);
                if (modifiers.Count > 0) Cancel.Sleep(cancel, 12);
            }
            finally
            {
                for (int n = modifiers.Count - 1; n >= 0; n--) if (heldKeys.Contains(modifiers[n])) KeyUp(modifiers[n]);
            }
        }

        /// <summary>Lets go of anything still held, so that a failed action never leaves a button or a modifier pressed.</summary>
        public void ReleaseAll()
        {
            foreach (KeyCode key in heldKeys.ToArray())
            {
                try { Send(new INPUT[] { Key(key.Vk, key.Extended, true) }); } catch (HelperException) { }
            }
            heldKeys.Clear();
            foreach (string button in heldButtons.ToArray())
            {
                try { Send(new INPUT[] { Mouse(UpFlag(button), 0, 0, 0) }); } catch (HelperException) { }
            }
            heldButtons.Clear();
        }
    }
}
