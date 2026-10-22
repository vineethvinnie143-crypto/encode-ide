using System;
using System.Collections.Generic;

namespace Encode.Desktop
{
    /// <summary>One key: its virtual-key code, and whether Windows treats it as an extended key.</summary>
    internal struct KeyCode
    {
        public ushort Vk;
        public bool Extended;

        public KeyCode(ushort vk, bool extended)
        {
            Vk = vk;
            Extended = extended;
        }
    }

    /// <summary>
    /// The key names keys.ts parses, as virtual-key codes. The tool has already refused what cannot be
    /// named; an unknown name here is a bug, and the call fails with a message the model can read.
    /// </summary>
    internal static class Keys
    {
        public const ushort VkShift = 0xA0;
        public const ushort VkControl = 0xA2;
        public const ushort VkMenu = 0xA4;

        private static readonly Dictionary<string, KeyCode> Table = Build();

        private static Dictionary<string, KeyCode> Build()
        {
            Dictionary<string, KeyCode> t = new Dictionary<string, KeyCode>();
            for (char c = 'a'; c <= 'z'; c++) t[c.ToString()] = new KeyCode((ushort)(0x41 + (c - 'a')), false);
            for (char c = '0'; c <= '9'; c++) t[c.ToString()] = new KeyCode((ushort)(0x30 + (c - '0')), false);
            for (int n = 1; n <= 24; n++) t["f" + n] = new KeyCode((ushort)(0x6F + n), false);
            for (int n = 0; n <= 9; n++) t["numpad" + n] = new KeyCode((ushort)(0x60 + n), false);
            t["enter"] = new KeyCode(0x0D, false);
            t["tab"] = new KeyCode(0x09, false);
            t["escape"] = new KeyCode(0x1B, false);
            t["backspace"] = new KeyCode(0x08, false);
            t["delete"] = new KeyCode(0x2E, true);
            t["insert"] = new KeyCode(0x2D, true);
            t["home"] = new KeyCode(0x24, true);
            t["end"] = new KeyCode(0x23, true);
            t["pageup"] = new KeyCode(0x21, true);
            t["pagedown"] = new KeyCode(0x22, true);
            t["up"] = new KeyCode(0x26, true);
            t["down"] = new KeyCode(0x28, true);
            t["left"] = new KeyCode(0x25, true);
            t["right"] = new KeyCode(0x27, true);
            t["space"] = new KeyCode(0x20, false);
            t["capslock"] = new KeyCode(0x14, false);
            t["numlock"] = new KeyCode(0x90, true);
            t["scrolllock"] = new KeyCode(0x91, false);
            t["printscreen"] = new KeyCode(0x2C, true);
            t["pause"] = new KeyCode(0x13, false);
            t["menu"] = new KeyCode(0x5D, true);
            t["minus"] = new KeyCode(0xBD, false);
            t["equals"] = new KeyCode(0xBB, false);
            t["comma"] = new KeyCode(0xBC, false);
            t["period"] = new KeyCode(0xBE, false);
            t["slash"] = new KeyCode(0xBF, false);
            t["semicolon"] = new KeyCode(0xBA, false);
            t["quote"] = new KeyCode(0xDE, false);
            t["lbracket"] = new KeyCode(0xDB, false);
            t["rbracket"] = new KeyCode(0xDD, false);
            t["backslash"] = new KeyCode(0xDC, false);
            t["backtick"] = new KeyCode(0xC0, false);
            t["numpadadd"] = new KeyCode(0x6B, false);
            t["numpadsubtract"] = new KeyCode(0x6D, false);
            t["numpadmultiply"] = new KeyCode(0x6A, false);
            t["numpaddivide"] = new KeyCode(0x6F, true);
            t["numpaddecimal"] = new KeyCode(0x6E, false);
            t["numpadenter"] = new KeyCode(0x0D, true);
            return t;
        }

        public static bool TryGet(string name, out KeyCode code)
        {
            return Table.TryGetValue((name ?? "").ToLowerInvariant(), out code);
        }

        public static int Count { get { return Table.Count; } }

        /// <summary>Keys that put a character in a text field when no ctrl or alt is held.</summary>
        public static bool Types(string name)
        {
            string key = (name ?? "").ToLowerInvariant();
            if (key.Length == 1) return true;
            switch (key)
            {
                case "space":
                case "minus":
                case "equals":
                case "comma":
                case "period":
                case "slash":
                case "semicolon":
                case "quote":
                case "lbracket":
                case "rbracket":
                case "backslash":
                case "backtick":
                    return true;
                default:
                    return key.StartsWith("numpad", StringComparison.Ordinal) && key != "numpadenter";
            }
        }

        /// <summary>Combinations that act on the desktop, not on the application the user allowed. keys.ts refuses them first; this is the second lock.</summary>
        public static string LeavesTheWindow(bool ctrl, bool alt, string key)
        {
            string name = (key ?? "").ToLowerInvariant();
            if (alt && (name == "tab" || name == "escape")) return "switches to another window";
            if (ctrl && name == "escape") return "opens the Start menu or the task manager";
            if (ctrl && alt && name == "delete") return "opens the security screen";
            return null;
        }
    }
}
