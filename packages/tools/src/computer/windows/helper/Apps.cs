using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text.RegularExpressions;

namespace Encode.Desktop
{
    /// <summary>An application of the Start menu: its name as people read it, the shell's id for it, and the program it runs when the shell says.</summary>
    internal sealed class StartApp
    {
        public string Name;
        public string Id;
        public string App;

        public Dictionary<string, object> ToJson()
        {
            Dictionary<string, object> map = new Dictionary<string, object>();
            map["name"] = Name;
            map["id"] = Id;
            if (App != null) map["app"] = App;
            return map;
        }
    }

    /// <summary>
    /// The Start menu as the shell's Applications folder lists it, programs and Store apps alike, and starting one of them the way the
    /// Start menu does. The shell starts it, so the program is the person's own and not a child of eNCode, and one that already runs (in
    /// the notification area, or behind other windows) is asked to show itself, as a second click on it in the Start menu would.
    /// </summary>
    internal static class StartMenu
    {
        private const int MaxApps = 3000;
        private static readonly Regex ProcessStart = new Regex("--processStart\\s+\"?([^\"\\s]+\\.exe)", RegexOptions.IgnoreCase);

        public static List<StartApp> List(Cancel cancel)
        {
            return Worker.RunSta<List<StartApp>>(Read, 20000, "The Start menu", cancel);
        }

        private static List<StartApp> Read()
        {
            Type type = Type.GetTypeFromProgID("Shell.Application");
            if (type == null) throw new HelperException("unavailable", "The Windows shell is not available, so the Start menu cannot be read.");
            object shell = Activator.CreateInstance(type);
            object folder = Call(shell, "NameSpace", "shell:AppsFolder");
            if (folder == null) throw new HelperException("unavailable", "The Windows shell has no Applications folder to read the Start menu from.");
            object items = Call(folder, "Items");
            int count = Convert.ToInt32(Get(items, "Count"), CultureInfo.InvariantCulture);
            List<StartApp> apps = new List<StartApp>();
            for (int i = 0; i < count && apps.Count < MaxApps; i++)
            {
                object item;
                try
                {
                    item = Call(items, "Item", i);
                }
                catch (Exception)
                {
                    continue;
                }
                if (item == null) continue;
                string name = Get(item, "Name") as string;
                string id = Get(item, "Path") as string;
                if (string.IsNullOrEmpty(name) || string.IsNullOrEmpty(id) || id.IndexOf('"') >= 0) continue;
                string program = ProgramOf(item, id);
                // A document, a web link or a help file is not an application; a Store app is named by an id with a "!".
                if (program == null && id.IndexOf('!') < 0) continue;
                StartApp app = new StartApp();
                app.Name = name.Trim();
                app.Id = id;
                app.App = program;
                apps.Add(app);
            }
            return apps;
        }

        /// <summary>
        /// The program an entry runs, by its file name: from the id when it is a program's path, else from the shortcut behind it.
        /// Squirrel's installer (Discord, Slack) starts the program through its Update.exe, which names it.
        /// </summary>
        private static string ProgramOf(object item, string id)
        {
            string direct = ExeName(id);
            if (direct != null) return direct;
            string program = ExeName(Extended(item, "System.Link.TargetParsingPath"));
            if (program == "update.exe")
            {
                Match match = ProcessStart.Match(Extended(item, "System.Link.Arguments") ?? "");
                if (match.Success) return match.Groups[1].Value.ToLowerInvariant();
            }
            return program;
        }

        private static string ExeName(string path)
        {
            if (string.IsNullOrEmpty(path) || !path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return null;
            int slash = Math.Max(path.LastIndexOf('\\'), path.LastIndexOf('/'));
            return path.Substring(slash + 1).ToLowerInvariant();
        }

        private static string Extended(object item, string property)
        {
            try
            {
                return Call(item, "ExtendedProperty", property) as string;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static object Call(object target, string method, params object[] args)
        {
            return target.GetType().InvokeMember(method, BindingFlags.InvokeMethod, null, target, args, CultureInfo.InvariantCulture);
        }

        private static object Get(object target, string property)
        {
            return target.GetType().InvokeMember(property, BindingFlags.GetProperty, null, target, null, CultureInfo.InvariantCulture);
        }

        /// <summary>
        /// Asks the shell to start the entry, as a click on it in the Start menu does. explorer.exe hands the request to the shell that
        /// is running and ends, so the application starts with the person's own environment, not the helper's short one.
        /// </summary>
        public static void Start(string id)
        {
            string windows = Environment.GetEnvironmentVariable("SystemRoot");
            if (string.IsNullOrEmpty(windows)) windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            string target = "shell:AppsFolder\\" + id;
            ProcessStartInfo info = new ProcessStartInfo(Path.Combine(windows, "explorer.exe"), target.IndexOf(' ') >= 0 ? "\"" + target + "\"" : target);
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            using (Process.Start(info))
            {
            }
        }
    }

    internal sealed partial class Session
    {
        /// <summary>How long an application that was open already gets to show something new before its window is the answer.</summary>
        private const int AlreadyOpenMs = 2000;

        private object Apps(Cancel cancel)
        {
            List<object> list = new List<object>();
            foreach (StartApp app in StartMenu.List(cancel)) list.Add(app.ToJson());
            return list;
        }

        /// <summary>
        /// Starts an application of the Start menu and waits for its window: a new one (the largest, if it shows more than one), or
        /// one of its windows that comes to the front. A window that closes again at once was a splash screen, and the wait goes on.
        /// </summary>
        private object Open(Dictionary<string, object> args, Cancel cancel)
        {
            string id = Args.Str(args, "id", null);
            string name = Args.Str(args, "name", "") ?? "";
            int waitMs = Clamp(Args.Int(args, "waitMs", 15000), 1000, 60000);
            if (string.IsNullOrEmpty(id) || id.Length > 2048 || id.IndexOf('"') >= 0) throw new HelperException("failed", "That is not an application of the Start menu.");
            StartApp entry = null;
            foreach (StartApp app in StartMenu.List(cancel))
            {
                if (app.Id == id)
                {
                    entry = app;
                    break;
                }
            }
            if (entry == null) throw new HelperException("no-element", (name.Length > 0 ? name : "That application") + " is not in the Start menu any more.");
            if (!input.DesktopAvailable()) throw new HelperException("unavailable", "The screen is locked or the session is disconnected, so nothing can be opened.");

            HashSet<long> before = new HashSet<long>();
            HashSet<long> splashes = new HashSet<long>();
            string already = null;
            foreach (WindowRecord record in windows.List())
            {
                before.Add(record.Hwnd.ToInt64());
                if (already == null && record.Blocked == null && Owns(record, entry)) already = record.Id;
            }
            IntPtr frontBefore = Native.GetForegroundWindow();
            StartMenu.Start(entry.Id);

            int waited = 0;
            while (waited < waitMs)
            {
                Cancel.Sleep(cancel, 200);
                waited += 200;
                IntPtr front = Native.GetForegroundWindow();
                WindowRecord found = null;
                foreach (WindowRecord record in windows.List())
                {
                    long handle = record.Hwnd.ToInt64();
                    if (record.Blocked != null || record.App == "shell" || splashes.Contains(handle)) continue;
                    bool inFront = WindowTable.Belongs(front, record.Hwnd);
                    bool owned = Owns(record, entry);
                    if (!before.Contains(handle))
                    {
                        // A program that starts the real one (a launcher) shows a window of another program, which bears the name.
                        if (!owned && !(inFront && Named(record, entry.Name))) continue;
                        if (found == null || record.Box.W * record.Box.H > found.Box.W * found.Box.H) found = record;
                    }
                    else if (found == null && owned && inFront && front != frontBefore)
                    {
                        found = record;
                    }
                }
                if (found == null && already != null && waited >= AlreadyOpenMs) found = windows.Find(already);
                if (found == null) continue;
                Cancel.Sleep(cancel, 400);
                WindowRecord now = windows.Find(found.Id);
                if (now != null) return now.ToJson();
                splashes.Add(found.Hwnd.ToInt64());
            }
            return null;
        }

        /// <summary>Whether a window is the application's: of the program the Start menu names, or, for a Store app, one that bears its name.</summary>
        private static bool Owns(WindowRecord record, StartApp entry)
        {
            if (entry.App != null) return record.App == entry.App;
            return Named(record, entry.Name);
        }

        private static bool Named(WindowRecord record, string name)
        {
            string wanted = name.Trim().ToLowerInvariant();
            if (wanted.Length < 3) return false;
            string title = record.Title.ToLowerInvariant();
            return record.Label.ToLowerInvariant() == wanted || title == wanted || title.EndsWith(" - " + wanted) || title.StartsWith(wanted + " - ") || title.StartsWith(wanted + " | ");
        }
    }
}
