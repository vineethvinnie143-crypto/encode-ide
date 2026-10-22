using System;
using System.Collections.Generic;
using System.Security.Principal;
using System.Text;

namespace Encode.Sandbox
{
    /// <summary>
    /// encode-sandbox.exe: starts programs under a write-restricted token and prepares the folders they may write.
    ///
    ///   run [options] -- program args...   starts the program; its standard handles are this process's
    ///   grant --sid S --path P [--protect X]...   lets the SID write P (and everything in it)
    ///   revoke --sid S --path P [--protect X]...  takes that back
    ///   check --sid S --path P            whether P carries the entry
    ///   probe [options]                   whether a program can be started this way here
    ///
    /// Answers other than a program's own output are one line of JSON on standard output. A failure is a line on
    /// standard error that starts with "encode-sandbox:" and exit code 125.
    /// </summary>
    internal static class Program
    {
        public const string Version = "1";
        private const int Failed = 125;

        private static void Write(System.IO.Stream stream, string line)
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
            public string Sid;
            public readonly List<string> Paths = new List<string>();
            public readonly List<string> Protect = new List<string>();
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
                    case "--restrict": parsed.Run.Restrict.Add(Value(args, ref i)); break;
                    case "--console": parsed.Run.Console = Value(args, ref i); break;
                    case "--cwd": parsed.Run.Cwd = Value(args, ref i); break;
                    case "--no-lua": parsed.Run.Lua = false; break;
                    case "--no-job": parsed.Run.UseJob = false; break;
                    case "--full-restriction": parsed.Run.WriteRestricted = false; break;
                    case "--sid": parsed.Sid = Value(args, ref i); break;
                    case "--path": parsed.Paths.Add(Value(args, ref i)); break;
                    case "--protect": parsed.Protect.Add(Value(args, ref i)); break;
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

        private static SecurityIdentifier SidOf(Parsed parsed)
        {
            if (string.IsNullOrEmpty(parsed.Sid)) throw new SandboxException("--sid is required.");
            return Sids.Resolve(parsed.Sid, IntPtr.Zero);
        }

        public static int Main(string[] args)
        {
            try
            {
                if (args.Length == 0) throw new SandboxException("No command. Use run, grant, revoke, check, probe or version.");
                switch (args[0])
                {
                    case "version":
                        Say(new JsonObject().Text("version", Version).ToString());
                        return 0;
                    case "run":
                    {
                        Parsed parsed = Parse(args, 1);
                        if (string.IsNullOrEmpty(parsed.Run.Program)) throw new SandboxException("No program to run.");
                        if (parsed.Run.Restrict.Count == 0) throw new SandboxException("--restrict is required.");
                        return Runner.Run(parsed.Run);
                    }
                    case "probe":
                    {
                        Parsed parsed = Parse(args, 1);
                        if (parsed.Run.Restrict.Count == 0) parsed.Run.Restrict.Add("everyone");
                        Say(Probe.Run(parsed.Run));
                        return 0;
                    }
                    case "grant":
                    {
                        Parsed parsed = Parse(args, 1);
                        SecurityIdentifier sid = SidOf(parsed);
                        if (parsed.Paths.Count == 0) throw new SandboxException("--path is required.");
                        JsonObject json = new JsonObject();
                        DateTime begun = DateTime.UtcNow;
                        List<string> done = new List<string>();
                        foreach (string path in parsed.Paths)
                        {
                            if (parsed.IfMissing && Acls.Has(path, sid)) continue;
                            Acls.Grant(path, sid, parsed.Protect);
                            done.Add(path);
                        }
                        json.Bool("ok", true).List("granted", done).Number("ms", (long)(DateTime.UtcNow - begun).TotalMilliseconds);
                        Say(json.ToString());
                        return 0;
                    }
                    case "revoke":
                    {
                        Parsed parsed = Parse(args, 1);
                        SecurityIdentifier sid = SidOf(parsed);
                        if (parsed.Paths.Count == 0) throw new SandboxException("--path is required.");
                        DateTime begun = DateTime.UtcNow;
                        foreach (string path in parsed.Paths) Acls.Revoke(path, sid, parsed.Protect);
                        Say(new JsonObject().Bool("ok", true).Number("ms", (long)(DateTime.UtcNow - begun).TotalMilliseconds).ToString());
                        return 0;
                    }
                    case "check":
                    {
                        Parsed parsed = Parse(args, 1);
                        SecurityIdentifier sid = SidOf(parsed);
                        if (parsed.Paths.Count == 0) throw new SandboxException("--path is required.");
                        List<string> present = new List<string>();
                        foreach (string path in parsed.Paths) if (Acls.Has(path, sid)) present.Add(path);
                        Say(new JsonObject().Bool("ok", true).List("present", present).ToString());
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
            catch (System.IO.IOException error)
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
