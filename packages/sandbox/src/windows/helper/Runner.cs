using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace Encode.Sandbox
{
    internal sealed class RunOptions
    {
        public readonly List<string> Restrict = new List<string>();
        public bool WriteRestricted = true;
        public bool Lua = true;
        public bool UseJob = true;
        /// <summary>"low": the program runs at the low integrity level and cannot write what is labeled higher. Empty: unchanged.</summary>
        public string Integrity = "";
        /// <summary>"all": the job limits the clipboard, other programs' windows and so on; "none": it does not.</summary>
        public string JobUi = "all";
        /// <summary>"none": nothing leaves the job; "ok": a program started with CREATE_BREAKAWAY_FROM_JOB may; "silent": every child leaves it.</summary>
        public string JobBreakaway = "none";
        /// <summary>inherit: the helper's own window station and desktop; own: a desktop of its own in the same window station; own-station: a window station and a desktop of its own.</summary>
        public string Desktop = "inherit";
        /// <summary>hidden: a console nobody sees; detached: none; inherit: the helper's own.</summary>
        public string Console = "hidden";
        public string Cwd;
        public string Program;
        public readonly List<string> Args = new List<string>();
    }

    /// <summary>
    /// Starts a program under a restricted and/or lowered token inside a job object, hands it the helper's own
    /// standard handles and waits for it. The job kills everything the program started when the helper goes away,
    /// however it goes.
    /// </summary>
    internal static class Runner
    {
        /// <summary>One argument as the Windows command line parser (CommandLineToArgvW) reads it back.</summary>
        public static string QuoteArgument(string argument)
        {
            if (argument.Length > 0 && argument.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return argument;
            StringBuilder sb = new StringBuilder();
            sb.Append('"');
            int backslashes = 0;
            foreach (char c in argument)
            {
                if (c == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (c == '"')
                {
                    sb.Append('\\', backslashes * 2 + 1);
                    sb.Append('"');
                }
                else
                {
                    sb.Append('\\', backslashes);
                    sb.Append(c);
                }
                backslashes = 0;
            }
            sb.Append('\\', backslashes * 2);
            sb.Append('"');
            return sb.ToString();
        }

        private static string CommandLine(RunOptions options)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append(QuoteArgument(options.Program));
            foreach (string argument in options.Args) sb.Append(' ').Append(QuoteArgument(argument));
            return sb.ToString();
        }

        private static void SetJobInformation(IntPtr job, int infoClass, object info)
        {
            int size = Marshal.SizeOf(info.GetType());
            IntPtr memory = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, memory, false);
                if (!Native.SetInformationJobObject(job, infoClass, memory, (uint)size)) throw SandboxException.Last("SetInformationJobObject(" + infoClass + ")");
            }
            finally
            {
                Marshal.FreeHGlobal(memory);
            }
        }

        private static IntPtr CreateJob(RunOptions options)
        {
            IntPtr job = Native.CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw SandboxException.Last("CreateJobObject");
            try
            {
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                limits.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if (options.JobBreakaway == "ok") limits.BasicLimitInformation.LimitFlags |= Native.JOB_OBJECT_LIMIT_BREAKAWAY_OK;
                else if (options.JobBreakaway == "silent") limits.BasicLimitInformation.LimitFlags |= Native.JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
                SetJobInformation(job, Native.JobObjectExtendedLimitInformation, limits);
                // No clipboard, no desktop switching, no USER handles of other programs, no system parameters.
                // A failure here leaves the job without its UI limits; the kill-on-close above is what is relied on.
                if (options.JobUi != "none")
                {
                    try
                    {
                        JOBOBJECT_BASIC_UI_RESTRICTIONS ui = new JOBOBJECT_BASIC_UI_RESTRICTIONS();
                        ui.UIRestrictionsClass = Native.JOB_OBJECT_UILIMIT_ALL_BUT_NONE;
                        SetJobInformation(job, Native.JobObjectBasicUIRestrictions, ui);
                    }
                    catch (SandboxException)
                    {
                    }
                }
                return job;
            }
            catch
            {
                Native.CloseHandle(job);
                throw;
            }
        }

        public static IList<SecurityIdentifier> ResolveAll(IList<string> specs, IntPtr token)
        {
            List<SecurityIdentifier> sids = new List<SecurityIdentifier>();
            foreach (string spec in specs)
            {
                SecurityIdentifier sid = Sids.Resolve(spec, token);
                if (!sids.Contains(sid)) sids.Add(sid);
            }
            return sids;
        }

        /// <summary>The token for a sandboxed program, ready to start one.</summary>
        public static IntPtr MakeToken(IntPtr own, RunOptions options)
        {
            IList<SecurityIdentifier> restricting = ResolveAll(options.Restrict, own);
            IntPtr restricted = Tokens.Restrict(own, restricting, options.WriteRestricted, options.Lua);
            try
            {
                // What the program makes (pipes, events, sections) must be open to it. An administrator's token names the
                // Administrators group there, which is deny-only in this one, so the person's own SID is named too.
                List<SecurityIdentifier> allowed = new List<SecurityIdentifier>();
                allowed.Add(Sids.TokenUserSid(own));
                allowed.Add(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null));
                allowed.Add(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null));
                foreach (SecurityIdentifier sid in restricting) if (!allowed.Contains(sid)) allowed.Add(sid);
                Tokens.SetDefaultDacl(restricted, allowed);
                if (options.Integrity == "low") Tokens.SetIntegrity(restricted, 0x1000);
                else if (options.Integrity.Length > 0) throw new SandboxException("Unknown integrity level: " + options.Integrity);
                return restricted;
            }
            catch
            {
                Native.CloseHandle(restricted);
                throw;
            }
        }

        public static int Run(RunOptions options)
        {
            IntPtr own = IntPtr.Zero;
            IntPtr token = IntPtr.Zero;
            IntPtr job = IntPtr.Zero;
            IntPtr attributes = IntPtr.Zero;
            IntPtr handleList = IntPtr.Zero;
            IntPtr desktopName = IntPtr.Zero;
            PrivateDesktop desktop = null;
            PROCESS_INFORMATION process = new PROCESS_INFORMATION();
            bool started = false;
            try
            {
                own = Tokens.OpenOwn();
                token = MakeToken(own, options);
                if (options.UseJob) job = CreateJob(options);

                IntPtr[] standard = new IntPtr[] { Native.GetStdHandle(-10), Native.GetStdHandle(-11), Native.GetStdHandle(-12) };
                List<IntPtr> inherited = new List<IntPtr>();
                foreach (IntPtr handle in standard)
                {
                    if (handle == IntPtr.Zero || handle == Native.InvalidHandle || inherited.Contains(handle)) continue;
                    // A handle that cannot be inherited is not given on; the program meets an invalid one.
                    if (Native.SetHandleInformation(handle, Native.HANDLE_FLAG_INHERIT, Native.HANDLE_FLAG_INHERIT)) inherited.Add(handle);
                }

                STARTUPINFOEX startup = new STARTUPINFOEX();
                startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
                startup.StartupInfo.dwFlags = Native.STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput = inherited.Contains(standard[0]) ? standard[0] : Native.InvalidHandle;
                startup.StartupInfo.hStdOutput = inherited.Contains(standard[1]) ? standard[1] : Native.InvalidHandle;
                startup.StartupInfo.hStdError = inherited.Contains(standard[2]) ? standard[2] : Native.InvalidHandle;

                // Only the three standard handles go to the program, not whatever else the helper was given.
                IntPtr size = IntPtr.Zero;
                Native.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
                attributes = Marshal.AllocHGlobal(size);
                if (!Native.InitializeProcThreadAttributeList(attributes, 1, 0, ref size))
                {
                    int error = Marshal.GetLastWin32Error();
                    Marshal.FreeHGlobal(attributes);
                    attributes = IntPtr.Zero;
                    throw new SandboxException("InitializeProcThreadAttributeList", error);
                }
                if (inherited.Count > 0)
                {
                    handleList = Marshal.AllocHGlobal(IntPtr.Size * inherited.Count);
                    for (int i = 0; i < inherited.Count; i++) Marshal.WriteIntPtr(handleList, i * IntPtr.Size, inherited[i]);
                    if (!Native.UpdateProcThreadAttribute(attributes, 0, Native.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handleList, new IntPtr(IntPtr.Size * inherited.Count), IntPtr.Zero, IntPtr.Zero)) throw SandboxException.Last("UpdateProcThreadAttribute");
                }
                startup.lpAttributeList = attributes;
                if (options.Desktop != "inherit")
                {
                    desktop = PrivateDesktop.Create(options.Desktop == "own-station", Sids.TokenUserSid(own));
                    desktopName = Marshal.StringToHGlobalUni(desktop.Name);
                    startup.StartupInfo.lpDesktop = desktopName;
                }

                uint flags = Native.CREATE_SUSPENDED | Native.CREATE_UNICODE_ENVIRONMENT | Native.EXTENDED_STARTUPINFO_PRESENT;
                if (options.Console == "hidden") flags |= Native.CREATE_NO_WINDOW;
                else if (options.Console == "detached") flags |= Native.DETACHED_PROCESS;

                string directory = string.IsNullOrEmpty(options.Cwd) ? null : options.Cwd;
                StringBuilder commandLine = new StringBuilder(CommandLine(options));
                if (!Native.CreateProcessAsUser(token, options.Program, commandLine, IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, directory, ref startup, out process)) throw SandboxException.Last("CreateProcessAsUser(" + options.Program + ")");
                started = true;

                if (job != IntPtr.Zero && !Native.AssignProcessToJobObject(job, process.hProcess)) throw SandboxException.Last("AssignProcessToJobObject");
                if (Native.ResumeThread(process.hThread) == 0xFFFFFFFF) throw SandboxException.Last("ResumeThread");
                Native.CloseHandle(process.hThread);
                process.hThread = IntPtr.Zero;

                Native.WaitForSingleObject(process.hProcess, Native.INFINITE);
                uint code;
                if (!Native.GetExitCodeProcess(process.hProcess, out code)) throw SandboxException.Last("GetExitCodeProcess");
                return unchecked((int)code);
            }
            catch
            {
                // A program that was made but never let go is not left suspended.
                if (started && process.hProcess != IntPtr.Zero) Native.TerminateProcess(process.hProcess, 125);
                throw;
            }
            finally
            {
                if (attributes != IntPtr.Zero)
                {
                    Native.DeleteProcThreadAttributeList(attributes);
                    Marshal.FreeHGlobal(attributes);
                }
                if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
                if (desktopName != IntPtr.Zero) Marshal.FreeHGlobal(desktopName);
                if (desktop != null) desktop.Dispose();
                if (process.hThread != IntPtr.Zero) Native.CloseHandle(process.hThread);
                if (process.hProcess != IntPtr.Zero) Native.CloseHandle(process.hProcess);
                if (token != IntPtr.Zero) Native.CloseHandle(token);
                if (own != IntPtr.Zero) Native.CloseHandle(own);
                // The job handle is closed last, by the process ending: that is what kills what the program left behind.
            }
        }
    }
}
