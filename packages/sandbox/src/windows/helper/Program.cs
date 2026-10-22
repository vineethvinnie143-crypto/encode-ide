using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace Encode.Sandbox
{
    /// <summary>
    /// encode-sandbox.exe: starts programs at the low integrity level and marks the folders they may write.
    ///
    ///   run [--integrity low|medium] [--cwd D] [--protect X]... -- program args...
    ///                                    starts the program; its standard handles are this process's
    ///   label --path P [--protect X]... [--if-missing]
    ///                                    marks P (and everything in it) so that low-integrity programs may write it;
    ///                                    progress is a line "encode-sandbox-progress: N" on standard error
    ///   unlabel --path P [--protect X]... takes the marks away
    ///   labels --path P...               the labels the paths carry
    ///   process-security --pid N...      who may open the running programs, and the label they carry
    ///   probe                            whether a program can be started this way here
    ///   version
    ///
    /// Answers other than a program's own output are one line of JSON on standard output. A failure is a line on
    /// standard error that starts with "encode-sandbox:" and exit code 125.
    /// </summary>
    internal static class Program
    {
        public const string Version = "2";
        private const int Failed = 125;

        private static void Write(Stream stream, string line)
        {
            byte[] bytes = new UTF8Encoding(false).GetBytes(line + "\n");
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush();
        }

        private static void Say(string line)
        {
            Write(Console.OpenStandardOutput(), line);
        }

        private static void Fail(string message)
        {
            Write(Console.OpenStandardError(), "encode-sandbox: " + message);
        }

        private sealed class Parsed
        {
            public readonly RunOptions Run = new RunOptions();
            public readonly List<string> Paths = new List<string>();
            public readonly List<string> Protect = new List<string>();
            public readonly List<int> Pids = new List<int>();
            public bool IfMissing;
        }

        private static Parsed Parse(string[] args, int start)
        {
            Parsed parsed = new Parsed();
            for (int i = start; i < args.Length; i++)
            {
                string arg = args[i];
                if (arg == "--")
                {
                    if (i + 1 >= args.Length) throw new SandboxException("No program after --.");
                    parsed.Run.Program = args[i + 1];
                    for (int j = i + 2; j < args.Length; j++) parsed.Run.Args.Add(args[j]);
                    return parsed;
                }
                switch (arg)
                {
                    case "--integrity": parsed.Run.Integrity = Value(args, ref i); break;
                    case "--cwd": parsed.Run.Cwd = Value(args, ref i); break;
                    case "--path": parsed.Paths.Add(Value(args, ref i)); break;
                    case "--protect":
                    {
                        string path = Value(args, ref i);
                        parsed.Protect.Add(path);
                        parsed.Run.Protect.Add(path);
                        break;
                    }
                    case "--pid":
                    {
                        int pid;
                        if (!int.TryParse(Value(args, ref i), out pid)) throw new SandboxException("--pid needs a number.");
                        parsed.Pids.Add(pid);
                        break;
                    }
                    case "--if-missing": parsed.IfMissing = true; break;
                    default: throw new SandboxException("Unknown option: " + arg);
                }
            }
            return parsed;
        }

        private static string Value(string[] args, ref int index)
        {
            if (index + 1 >= args.Length) throw new SandboxException("Missing value after " + args[index]);
            index++;
            return args[index];
        }

        private static void Progress(long done)
        {
            Write(Console.OpenStandardError(), "encode-sandbox-progress: " + done);
        }

        private static string Label(Parsed parsed)
        {
            if (parsed.Paths.Count == 0) throw new SandboxException("--path is required.");
            DateTime begun = DateTime.UtcNow;
            List<string> done = new List<string>();
            long folders = 0;
            long files = 0;
            long linked = 0;
            long redirected = 0;
            long failed = 0;
            List<string> failures = new List<string>();
            foreach (string path in parsed.Paths)
            {
                bool folder;
                if (!LabelWalker.Exists(path, out folder) || !folder) throw new SandboxException("Not a folder: " + path);
                if (parsed.IfMissing && Labels.IsLow(path)) continue;
                LabelWalker walker = LabelWalker.Run(path, parsed.Protect, Progress);
                done.Add(path);
                folders += walker.Folders;
                files += walker.Files;
                linked += walker.Linked;
                redirected += walker.Redirected;
                failed += walker.Failed;
                failures.AddRange(walker.Failures);
            }
            // What the command must not change inside is labeled medium again, and no longer takes the folder's label.
            foreach (string item in parsed.Protect) Labels.Protect(item);
            return new JsonObject()
                .Bool("ok", true)
                .List("labeled", done)
                .Number("folders", folders)
                .Number("files", files)
                .Number("linked", linked)
                .Number("redirected", redirected)
                .Number("failed", failed)
                .List("failures", failures)
                .Number("ms", (long)(DateTime.UtcNow - begun).TotalMilliseconds)
                .ToString();
        }

        public static int Main(string[] args)
        {
            try
            {
                if (args.Length == 0) throw new SandboxException("No command. Use run, label, unlabel, labels, process-security, probe or version.");
                switch (args[0])
                {
                    case "version":
                        Say(new JsonObject().Text("version", Version).ToString());
                        return 0;
                    case "run":
                    {
                        Parsed parsed = Parse(args, 1);
                        if (string.IsNullOrEmpty(parsed.Run.Program)) throw new SandboxException("No program to run.");
                        return Runner.Run(parsed.Run);
                    }
                    case "probe":
                        Say(Probe.Run());
                        return 0;
                    case "label":
                        Say(Label(Parse(args, 1)));
                        return 0;
                    case "unlabel":
                    {
                        Parsed parsed = Parse(args, 1);
                        if (parsed.Paths.Count == 0) throw new SandboxException("--path is required.");
                        DateTime begun = DateTime.UtcNow;
                        // What was protected goes first: the folders around it would otherwise hand their removal down to it.
                        bool folder;
                        foreach (string item in parsed.Protect) if (LabelWalker.Exists(item, out folder)) Labels.Apply(item, "");
                        foreach (string path in parsed.Paths) if (LabelWalker.Exists(path, out folder) && folder) Labels.Apply(path, "");
                        Say(new JsonObject().Bool("ok", true).Number("ms", (long)(DateTime.UtcNow - begun).TotalMilliseconds).ToString());
                        return 0;
                    }
                    case "labels":
                    {
                        Parsed parsed = Parse(args, 1);
                        if (parsed.Paths.Count == 0) throw new SandboxException("--path is required.");
                        List<string> found = new List<string>();
                        foreach (string path in parsed.Paths) found.Add(path + " => " + Labels.Get(path));
                        Say(new JsonObject().Bool("ok", true).List("labels", found).ToString());
                        return 0;
                    }
                    case "process-security":
                    {
                        Parsed parsed = Parse(args, 1);
                        if (parsed.Pids.Count == 0) throw new SandboxException("--pid is required.");
                        List<string> found = new List<string>();
                        foreach (int pid in parsed.Pids) found.Add(pid + " => " + Labels.OfProcess(pid));
                        Say(new JsonObject().Bool("ok", true).List("processes", found).ToString());
                        return 0;
                    }
                    default:
                        throw new SandboxException("Unknown command: " + args[0]);
                }
            }
            catch (SandboxException error)
            {
                Fail(error.Message);
                return Failed;
            }
            catch (UnauthorizedAccessException error)
            {
                Fail("Access is denied: " + error.Message);
                return Failed;
            }
            catch (IOException error)
            {
                Fail(error.Message);
                return Failed;
            }
            catch (InvalidOperationException error)
            {
                Fail(error.Message);
                return Failed;
            }
        }
    }
}
