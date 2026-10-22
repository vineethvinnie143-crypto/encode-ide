using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

namespace Encode.Sandbox
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct WIN32_FIND_DATA
    {
        public uint dwFileAttributes;
        public FileTimeValue ftCreationTime;
        public FileTimeValue ftLastAccessTime;
        public FileTimeValue ftLastWriteTime;
        public uint nFileSizeHigh;
        public uint nFileSizeLow;
        public uint dwReserved0;
        public uint dwReserved1;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string cFileName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)]
        public string cAlternateFileName;
    }

    /// <summary>
    /// Labels a folder and everything in it low, one object at a time. The system's own walk (SetNamedSecurityInfo)
    /// follows a hard link into the file wherever else it is linked, which would make a file that is shared with the
    /// outside (a package manager's content store) writable for the sandboxed command; this one leaves files with
    /// more than one link alone, and does not follow junctions or symbolic links. Paths may be longer than the
    /// classic limit, which node_modules folders are.
    /// </summary>
    internal sealed class LabelWalker
    {
        private const uint SHARE_ALL = Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE | Native.FILE_SHARE_DELETE;
        private const uint FILE_ATTRIBUTE_DIRECTORY = 0x10;
        private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
        private const uint IO_REPARSE_TAG_MOUNT_POINT = 0xA0000003;
        private const uint IO_REPARSE_TAG_SYMLINK = 0xA000000C;
        private const int FindExInfoBasic = 1;
        private const int FindExSearchNameMatch = 0;
        private const int FIND_FIRST_EX_LARGE_FETCH = 2;
        private const int MaxFailureNotes = 5;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr FindFirstFileExW(string fileName, int infoLevel, out WIN32_FIND_DATA data, int searchOp, IntPtr filter, int flags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool FindNextFileW(IntPtr find, out WIN32_FIND_DATA data);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool FindClose(IntPtr find);

        private readonly HashSet<string> skip = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private IntPtr folderLabel = IntPtr.Zero;
        private IntPtr fileLabel = IntPtr.Zero;
        private DateTime reported = DateTime.UtcNow;
        private readonly Action<long> progress;

        public long Folders;
        public long Files;
        /// <summary>Files with more than one link, left as they are.</summary>
        public long Linked;
        /// <summary>Junctions and symbolic links, neither followed nor labeled.</summary>
        public long Redirected;
        public long Failed;
        public readonly List<string> Failures = new List<string>();

        private LabelWalker(Action<long> progress)
        {
            this.progress = progress;
        }

        /// <summary>Labels `root` low (everything in it, now and later), except the paths in `leave`, which are not touched.</summary>
        public static LabelWalker Run(string root, IEnumerable<string> leave, Action<long> progress)
        {
            LabelWalker walker = new LabelWalker(progress);
            try
            {
                walker.Prepare(leave);
                string start = Extended(root);
                walker.Visit(start);
                // The folder's own label comes last, so that a walk that was cut short is not taken for a finished one.
                walker.LabelPath(start, true, true);
                return walker;
            }
            finally
            {
                walker.Free();
            }
        }

        private void Prepare(IEnumerable<string> leave)
        {
            foreach (string path in leave) skip.Add(Extended(path).TrimEnd('\\'));
            folderLabel = Labels.Descriptor("S:AI(ML;OICIID;NW;;;LW)");
            fileLabel = Labels.Descriptor("S:AI(ML;ID;NW;;;LW)");
        }

        private void Free()
        {
            if (folderLabel != IntPtr.Zero) Native.LocalFree(folderLabel);
            if (fileLabel != IntPtr.Zero) Native.LocalFree(fileLabel);
            folderLabel = IntPtr.Zero;
            fileLabel = IntPtr.Zero;
        }

        /// <summary>The path in the form that has no length limit and is not normalized by the system.</summary>
        public static string Extended(string path)
        {
            if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path;
            string full = Path.GetFullPath(path);
            if (full.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + full.Substring(2);
            return @"\\?\" + full;
        }

        private void Fail(string path, int error)
        {
            Failed++;
            if (Failures.Count < MaxFailureNotes) Failures.Add(path + " (error " + error + ")");
        }

        private void Report()
        {
            if (progress == null) return;
            DateTime now = DateTime.UtcNow;
            if ((now - reported).TotalMilliseconds < 1000) return;
            reported = now;
            progress(Folders + Files);
        }

        /// <summary>Labels one object. Returns false when it was left alone or could not be labeled.</summary>
        private bool LabelPath(string path, bool folder, bool isRoot)
        {
            IntPtr handle = Native.CreateFileW(path, Native.WRITE_OWNER | Native.FILE_READ_ATTRIBUTES, SHARE_ALL, IntPtr.Zero, Native.OPEN_EXISTING, Native.FILE_FLAG_BACKUP_SEMANTICS | Native.FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
            if (handle == Native.InvalidHandle)
            {
                int error = Marshal.GetLastWin32Error();
                if (isRoot) throw new SandboxException("CreateFile(" + path + ")", error);
                Fail(path, error);
                return false;
            }
            try
            {
                if (!folder)
                {
                    BY_HANDLE_FILE_INFORMATION info;
                    if (!Native.GetFileInformationByHandle(handle, out info))
                    {
                        Fail(path, Marshal.GetLastWin32Error());
                        return false;
                    }
                    if (info.nNumberOfLinks > 1)
                    {
                        Linked++;
                        return false;
                    }
                }
                IntPtr descriptor;
                if (isRoot) descriptor = Labels.Descriptor("S:(ML;OICI;NW;;;LW)");
                else descriptor = folder ? folderLabel : fileLabel;
                try
                {
                    if (!Native.SetKernelObjectSecurity(handle, Native.LABEL_SECURITY_INFORMATION, descriptor))
                    {
                        int error = Marshal.GetLastWin32Error();
                        if (isRoot) throw new SandboxException("SetKernelObjectSecurity(" + path + ")", error);
                        Fail(path, error);
                        return false;
                    }
                }
                finally
                {
                    if (isRoot) Native.LocalFree(descriptor);
                }
                if (folder) Folders++;
                else Files++;
                return true;
            }
            finally
            {
                Native.CloseHandle(handle);
            }
        }

        private void Visit(string directory)
        {
            List<string> folders = new List<string>();
            WIN32_FIND_DATA data;
            IntPtr find = FindFirstFileExW(directory.TrimEnd('\\') + @"\*", FindExInfoBasic, out data, FindExSearchNameMatch, IntPtr.Zero, FIND_FIRST_EX_LARGE_FETCH);
            if (find == Native.InvalidHandle)
            {
                int error = Marshal.GetLastWin32Error();
                // An empty or vanished folder is not a failure of the walk; one that cannot be listed is.
                if (error != 2 && error != 3 && error != 18) Fail(directory, error);
                return;
            }
            try
            {
                do
                {
                    string name = data.cFileName;
                    if (name == "." || name == "..") continue;
                    string full = directory.TrimEnd('\\') + "\\" + name;
                    if (skip.Contains(full)) continue;
                    bool folder = (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
                    if ((data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 && (data.dwReserved0 == IO_REPARSE_TAG_MOUNT_POINT || data.dwReserved0 == IO_REPARSE_TAG_SYMLINK))
                    {
                        Redirected++;
                        continue;
                    }
                    if (folder)
                    {
                        if (LabelPath(full, true, false)) folders.Add(full);
                    }
                    else
                    {
                        LabelPath(full, false, false);
                    }
                    Report();
                }
                while (FindNextFileW(find, out data));
            }
            finally
            {
                FindClose(find);
            }
            // The folders are visited after the listing is closed: a handle per level of depth is enough.
            foreach (string folder in folders) Visit(folder);
        }
    }
}
