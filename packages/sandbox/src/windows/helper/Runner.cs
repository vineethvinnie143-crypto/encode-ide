using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Encode.Sandbox
{
    internal sealed class RunOptions
    {
        /// <summary>"low": the program cannot write, delete or rename what is labeled higher; "medium": it runs as an ordinary program of the person does (for the measurement).</summary>
        public string Integrity = "low";
        public string Cwd;
        public string Program;
        public readonly List<string> Args = new List<string>();
        /// <summary>Paths the program must not write: labeled medium before it starts.</summary>
        public readonly List<string> Protect = new List<string>();
    }

    /// <summary>
    /// Starts a program under a lowered token inside a job object, hands it the helper's own standard handles and
    /// waits for it. The job kills everything the program started when the helper goes away, however it goes.
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

        private static IntPtr CreateJob()
        {
            IntPtr job = Native.CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw SandboxException.Last("CreateJobObject");
            try
            {
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                limits.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetJobInformation(job, Native.JobObjectExtendedLimitInformation, limits);
                // No clipboard, no desktop switching, no handles to other programs' windows, no system parameters.
                // A failure here leaves the job without those limits; the kill-on-close above is what is relied on.
                try
                {
                    JOBOBJECT_BASIC_UI_RESTRICTIONS ui = new JOBOBJECT_BASIC_UI_RESTRICTIONS();
                    ui.UIRestrictionsClass = Native.JOB_OBJECT_UILIMIT_ALL;
                    SetJobInformation(job, Native.JobObjectBasicUIRestrictions, ui);
                }
                catch (SandboxException)
                {
                }
                return job;
            }
            catch
            {
                Native.CloseHandle(job);
                throw;
            }
        }

        private static uint Level(string integrity)
        {
            if (integrity == "low") return 0x1000;
            if (integrity == "medium") return 0x2000;
            throw new SandboxException("Unknown integrity level: " + integrity);
        }

        public static int Run(RunOptions options)
        {
            IntPtr own = IntPtr.Zero;
            IntPtr token = IntPtr.Zero;
            IntPtr job = IntPtr.Zero;
            IntPtr attributes = IntPtr.Zero;
            IntPtr handleList = IntPtr.Zero;
            PROCESS_INFORMATION process = new PROCESS_INFORMATION();
            bool started = false;
            try
            {
                uint level = Level(options.Integrity);
                // The protected paths are labeled before the program exists, so that there is no moment in which it
                // could write them; one made again since the last command carried its folder's low label until now.
                foreach (string path in options.Protect) Labels.Protect(path);

                own = Tokens.OpenOwn();
                token = Tokens.Lowered(own, level);
                job = CreateJob();

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

                // A console nobody sees: the program talks through the handles it was given.
                uint flags = Native.CREATE_SUSPENDED | Native.CREATE_UNICODE_ENVIRONMENT | Native.EXTENDED_STARTUPINFO_PRESENT | Native.CREATE_NO_WINDOW;

                string directory = string.IsNullOrEmpty(options.Cwd) ? null : options.Cwd;
                StringBuilder commandLine = new StringBuilder(CommandLine(options));
                if (!Native.CreateProcessAsUser(token, options.Program, commandLine, IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, directory, ref startup, out process)) throw SandboxException.Last("CreateProcessAsUser(" + options.Program + ")");
                started = true;

                if (!Native.AssignProcessToJobObject(job, process.hProcess)) throw SandboxException.Last("AssignProcessToJobObject");
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
                if (process.hThread != IntPtr.Zero) Native.CloseHandle(process.hThread);
                if (process.hProcess != IntPtr.Zero) Native.CloseHandle(process.hProcess);
                if (token != IntPtr.Zero) Native.CloseHandle(token);
                if (own != IntPtr.Zero) Native.CloseHandle(own);
                // The job handle is closed by the helper ending: that is what kills what the program left behind.
            }
        }
    }
}
