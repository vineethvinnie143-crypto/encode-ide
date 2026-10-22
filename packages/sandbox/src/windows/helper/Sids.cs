using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace Encode.Sandbox
{
    /// <summary>A failure the caller is told about, with the Win32 error that explains it.</summary>
    internal sealed class SandboxException : Exception
    {
        public readonly int Win32;

        public SandboxException(string message) : base(message)
        {
        }

        public SandboxException(string what, int win32) : base(what + " failed: " + new Win32Exception(win32).Message + " (error " + win32 + ")")
        {
            Win32 = win32;
        }

        public static SandboxException Last(string what)
        {
            return new SandboxException(what, Marshal.GetLastWin32Error());
        }
    }

    internal static class Sids
    {
        public static SecurityIdentifier TokenUserSid(IntPtr token)
        {
            uint needed;
            Native.GetTokenInformation(token, Native.TokenUser, IntPtr.Zero, 0, out needed);
            IntPtr buffer = Marshal.AllocHGlobal((int)needed);
            try
            {
                if (!Native.GetTokenInformation(token, Native.TokenUser, buffer, needed, out needed)) throw SandboxException.Last("GetTokenInformation(TokenUser)");
                SID_AND_ATTRIBUTES user = (SID_AND_ATTRIBUTES)Marshal.PtrToStructure(buffer, typeof(SID_AND_ATTRIBUTES));
                return new SecurityIdentifier(user.Sid);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        /// <summary>The SID of the logon session (S-1-5-5-x-y), or null when the token has none.</summary>
        public static SecurityIdentifier LogonSid(IntPtr token)
        {
            uint needed;
            Native.GetTokenInformation(token, Native.TokenGroups, IntPtr.Zero, 0, out needed);
            IntPtr buffer = Marshal.AllocHGlobal((int)needed);
            try
            {
                if (!Native.GetTokenInformation(token, Native.TokenGroups, buffer, needed, out needed)) throw SandboxException.Last("GetTokenInformation(TokenGroups)");
                int count = Marshal.ReadInt32(buffer);
                int offset = IntPtr.Size; // GroupCount is a DWORD, then the array starts at pointer alignment.
                int size = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
                for (int i = 0; i < count; i++)
                {
                    SID_AND_ATTRIBUTES group = (SID_AND_ATTRIBUTES)Marshal.PtrToStructure(new IntPtr(buffer.ToInt64() + offset + i * size), typeof(SID_AND_ATTRIBUTES));
                    if ((group.Attributes & Native.SE_GROUP_LOGON_ID) == Native.SE_GROUP_LOGON_ID) return new SecurityIdentifier(group.Sid);
                }
                return null;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        /// <summary>Copies a SID into unmanaged memory, to be freed with Marshal.FreeHGlobal.</summary>
        public static IntPtr ToUnmanaged(SecurityIdentifier sid)
        {
            byte[] bytes = new byte[sid.BinaryLength];
            sid.GetBinaryForm(bytes, 0);
            IntPtr memory = Marshal.AllocHGlobal(bytes.Length);
            Marshal.Copy(bytes, 0, memory, bytes.Length);
            return memory;
        }
    }
}
