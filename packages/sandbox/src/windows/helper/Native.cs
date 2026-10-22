using System;
using System.Runtime.InteropServices;
using System.Text;

namespace Encode.Sandbox
{
    [StructLayout(LayoutKind.Sequential)]
    internal struct SID_AND_ATTRIBUTES
    {
        public IntPtr Sid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct TOKEN_DEFAULT_DACL
    {
        public IntPtr DefaultDacl;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct STARTUPINFO
    {
        public int cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JOBOBJECT_BASIC_UI_RESTRICTIONS
    {
        public uint UIRestrictionsClass;
    }

    /// <summary>A FILETIME: two 32-bit halves. Declared here because two namespaces in the framework have one of that name.</summary>
    [StructLayout(LayoutKind.Sequential)]
    internal struct FileTimeValue
    {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct BY_HANDLE_FILE_INFORMATION
    {
        public uint dwFileAttributes;
        public FileTimeValue ftCreationTime;
        public FileTimeValue ftLastAccessTime;
        public FileTimeValue ftLastWriteTime;
        public uint dwVolumeSerialNumber;
        public uint nFileSizeHigh;
        public uint nFileSizeLow;
        public uint nNumberOfLinks;
        public uint nFileIndexHigh;
        public uint nFileIndexLow;
    }

    internal static class Native
    {
        public const uint TOKEN_ALL_ACCESS = 0xF01FF;

        public const uint DISABLE_MAX_PRIVILEGE = 0x1;
        public const uint LUA_TOKEN = 0x4;

        public const int TokenUser = 1;
        public const int TokenGroups = 2;
        public const int TokenDefaultDacl = 6;
        public const int TokenElevation = 20;
        public const int TokenIntegrityLevel = 25;

        public const uint SE_GROUP_LOGON_ID = 0xC0000000;
        public const uint SE_GROUP_INTEGRITY = 0x00000020;

        public const int SE_FILE_OBJECT = 1;
        public const int SE_KERNEL_OBJECT = 6;
        public const uint SDDL_REVISION_1 = 1;
        public const uint OWNER_SECURITY_INFORMATION = 0x00000001;
        public const uint DACL_SECURITY_INFORMATION = 0x00000004;
        public const uint LABEL_SECURITY_INFORMATION = 0x00000010;
        public const uint READ_CONTROL = 0x00020000;
        public const uint WRITE_OWNER = 0x00080000;
        public const uint FILE_READ_ATTRIBUTES = 0x00000080;
        public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;

        public const uint FILE_SHARE_READ = 1;
        public const uint FILE_SHARE_WRITE = 2;
        public const uint FILE_SHARE_DELETE = 4;
        public const uint OPEN_EXISTING = 3;
        public const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        public const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;

        public const uint CREATE_SUSPENDED = 0x00000004;
        public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        public const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        public const uint CREATE_NO_WINDOW = 0x08000000;

        public const int STARTF_USESTDHANDLES = 0x00000100;
        public static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = new IntPtr(0x00020002);

        public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        public const int JobObjectBasicUIRestrictions = 4;
        public const int JobObjectExtendedLimitInformation = 9;

        /// <summary>Handles, clipboard, system parameters, display settings, global atoms, desktops and ExitWindows: all limited.</summary>
        public const uint JOB_OBJECT_UILIMIT_ALL = 0xFF;

        public const uint HANDLE_FLAG_INHERIT = 1;
        public const uint INFINITE = 0xFFFFFFFF;

        public static readonly IntPtr InvalidHandle = new IntPtr(-1);

        [DllImport("kernel32.dll")]
        public static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr GetStdHandle(int which);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint size);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);

        [DllImport("kernel32.dll")]
        public static extern void DeleteProcThreadAttributeList(IntPtr list);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateFileW(string fileName, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetFileInformationByHandle(IntPtr file, out BY_HANDLE_FILE_INFORMATION info);

        // The Framework's own path functions (Path.GetFullPath, Directory.Exists) refuse "\\?\" paths and paths past
        // 260 characters in a program built with csc, which runs with the old path rules: these are the system's.
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern uint GetFileAttributesW(string fileName);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern uint GetFullPathNameW(string fileName, uint bufferLength, StringBuilder buffer, IntPtr filePart);

        public const uint INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF;
        public const uint FILE_ATTRIBUTE_DIRECTORY = 0x10;

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);

        [DllImport("kernel32.dll")]
        public static extern IntPtr LocalFree(IntPtr memory);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool CreateRestrictedToken(
            IntPtr existing,
            uint flags,
            uint disableSidCount,
            IntPtr sidsToDisable,
            uint deletePrivilegeCount,
            IntPtr privilegesToDelete,
            uint restrictSidCount,
            IntPtr sidsToRestrict,
            out IntPtr newToken);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool SetTokenInformation(IntPtr token, int infoClass, IntPtr info, uint size);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, uint size, out uint needed);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, out uint size);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr descriptor, uint revision, uint information, out IntPtr text, out uint size);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool GetSecurityDescriptorSacl(IntPtr descriptor, out bool present, out IntPtr sacl, out bool defaulted);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool SetKernelObjectSecurity(IntPtr handle, uint information, IntPtr descriptor);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
        public static extern uint SetNamedSecurityInfo(string name, int type, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
        public static extern uint GetNamedSecurityInfo(string name, int type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);

        [DllImport("advapi32.dll")]
        public static extern uint GetSecurityInfo(IntPtr handle, int type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool CreateProcessAsUser(
            IntPtr token,
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFOEX startupInfo,
            out PROCESS_INFORMATION processInformation);
    }
}
