using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Principal;

namespace Encode.Sandbox
{
    /// <summary>Whether this machine lets the helper do its work, shown to the person as the sandbox's state.</summary>
    internal static class Probe
    {
        public static string Run(RunOptions options)
        {
            JsonObject json = new JsonObject();
            IntPtr own = IntPtr.Zero;
            try
            {
                own = Tokens.OpenOwn();
                json.Text("user", Sids.TokenUserSid(own).Value);
                json.Bool("elevated", Tokens.QueryUint(own, Native.TokenElevation) != 0);
                json.Number("integrity", Tokens.IntegrityRid(own));
                SecurityIdentifier logon = Sids.LogonSid(own);
                json.Text("logon", logon == null ? "" : logon.Value);
                bool inJob;
                json.Bool("inJob", Native.IsProcessInJob(Native.GetCurrentProcess(), IntPtr.Zero, out inJob) && inJob);
            }
            catch (SandboxException error)
            {
                json.Text("tokenError", error.Message);
            }
            finally
            {
                if (own != IntPtr.Zero) Native.CloseHandle(own);
            }

            // The real test: a program starts under the restricted token, in a job, and its exit code comes back.
            RunOptions test = new RunOptions();
            test.Restrict.AddRange(options.Restrict);
            test.WriteRestricted = options.WriteRestricted;
            test.Lua = options.Lua;
            test.UseJob = options.UseJob;
            test.Integrity = options.Integrity;
            test.JobUi = options.JobUi;
            test.JobBreakaway = options.JobBreakaway;
            test.Desktop = options.Desktop;
            test.Console = options.Console;
            test.Program = Path.Combine(Environment.SystemDirectory, "cmd.exe");
            test.Args.Add("/d");
            test.Args.Add("/c");
            test.Args.Add("exit 7");
            try
            {
                int code = Runner.Run(test);
                json.Bool("ok", code == 7);
                json.Number("code", code);
                if (code != 7) json.Text("error", "A test program started under the restricted token returned " + code + " instead of 7.");
            }
            catch (SandboxException error)
            {
                json.Bool("ok", false);
                json.Text("error", error.Message);
            }
            json.Text("version", Program.Version);
            return json.ToString();
        }
    }
}
