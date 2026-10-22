using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;

namespace Encode.Sandbox
{
    /// <summary>
    /// The token a sandboxed command runs under: the caller's own, without its privileges, with an administrator's
    /// group turned into deny-only, and lowered to the low integrity level, which cannot write, delete or rename
    /// anything labeled higher. Reading is not restricted.
    /// </summary>
    internal static class Tokens
    {
        public static IntPtr OpenOwn()
        {
            IntPtr token;
            if (!Native.OpenProcessToken(Native.GetCurrentProcess(), Native.TOKEN_ALL_ACCESS, out token)) throw SandboxException.Last("OpenProcessToken");
            return token;
        }

        /// <summary>The own token without privileges and administrator rights, at the integrity level (0x1000 low, 0x2000 medium).</summary>
        public static IntPtr Lowered(IntPtr own, uint rid)
        {
            IntPtr token;
            if (!Native.CreateRestrictedToken(own, Native.DISABLE_MAX_PRIVILEGE | Native.LUA_TOKEN, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out token))
            {
                // Some systems refuse the administrator rewrite; the integrity level, not the groups, is what confines the program.
                int error = Marshal.GetLastWin32Error();
                if (!Native.CreateRestrictedToken(own, Native.DISABLE_MAX_PRIVILEGE, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out token)) throw new SandboxException("CreateRestrictedToken", error);
            }
            try
            {
                // What the program makes (pipes, events, sections) must be open to it. An administrator's token names the
                // Administrators group there, which is deny-only in this one, so the person's own SID is named too.
                List<SecurityIdentifier> allowed = new List<SecurityIdentifier>();
                allowed.Add(Sids.TokenUserSid(own));
                allowed.Add(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null));
                allowed.Add(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null));
                SetDefaultDacl(token, allowed);
                SetIntegrity(token, rid);
                return token;
            }
            catch
            {
                Native.CloseHandle(token);
                throw;
            }
        }

        private static void SetIntegrity(IntPtr token, uint rid)
        {
            SecurityIdentifier level = new SecurityIdentifier("S-1-16-" + rid);
            IntPtr sid = Sids.ToUnmanaged(level);
            IntPtr info = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES)));
            try
            {
                SID_AND_ATTRIBUTES label = new SID_AND_ATTRIBUTES();
                label.Sid = sid;
                label.Attributes = Native.SE_GROUP_INTEGRITY;
                Marshal.StructureToPtr(label, info, false);
                // The size is that of the label structure plus the SID it points to.
                if (!Native.SetTokenInformation(token, Native.TokenIntegrityLevel, info, (uint)(Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES)) + level.BinaryLength))) throw SandboxException.Last("SetTokenInformation(TokenIntegrityLevel)");
            }
            finally
            {
                Marshal.FreeHGlobal(info);
                Marshal.FreeHGlobal(sid);
            }
        }

        private static void SetDefaultDacl(IntPtr token, IList<SecurityIdentifier> allowed)
        {
            RawAcl acl = new RawAcl(GenericAcl.AclRevision, allowed.Count);
            foreach (SecurityIdentifier sid in allowed) acl.InsertAce(acl.Count, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, 0x10000000, sid, false, null));
            byte[] bytes = new byte[acl.BinaryLength];
            acl.GetBinaryForm(bytes, 0);
            IntPtr aclMemory = Marshal.AllocHGlobal(bytes.Length);
            IntPtr info = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TOKEN_DEFAULT_DACL)));
            try
            {
                Marshal.Copy(bytes, 0, aclMemory, bytes.Length);
                TOKEN_DEFAULT_DACL dacl = new TOKEN_DEFAULT_DACL();
                dacl.DefaultDacl = aclMemory;
                Marshal.StructureToPtr(dacl, info, false);
                if (!Native.SetTokenInformation(token, Native.TokenDefaultDacl, info, (uint)Marshal.SizeOf(typeof(TOKEN_DEFAULT_DACL)))) throw SandboxException.Last("SetTokenInformation(TokenDefaultDacl)");
            }
            finally
            {
                Marshal.FreeHGlobal(info);
                Marshal.FreeHGlobal(aclMemory);
            }
        }

        public static uint QueryUint(IntPtr token, int infoClass)
        {
            IntPtr buffer = Marshal.AllocHGlobal(4);
            try
            {
                uint needed;
                if (!Native.GetTokenInformation(token, infoClass, buffer, 4, out needed)) return 0;
                return (uint)Marshal.ReadInt32(buffer);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        /// <summary>The integrity level's RID (0x1000 low, 0x2000 medium, 0x3000 high, 0x4000 system), or 0 when unknown.</summary>
        public static uint IntegrityRid(IntPtr token)
        {
            uint needed;
            Native.GetTokenInformation(token, Native.TokenIntegrityLevel, IntPtr.Zero, 0, out needed);
            if (needed == 0) return 0;
            IntPtr buffer = Marshal.AllocHGlobal((int)needed);
            try
            {
                if (!Native.GetTokenInformation(token, Native.TokenIntegrityLevel, buffer, needed, out needed)) return 0;
                SID_AND_ATTRIBUTES label = (SID_AND_ATTRIBUTES)Marshal.PtrToStructure(buffer, typeof(SID_AND_ATTRIBUTES));
                SecurityIdentifier sid = new SecurityIdentifier(label.Sid);
                string text = sid.Value;
                int dash = text.LastIndexOf('-');
                uint rid;
                return dash > 0 && uint.TryParse(text.Substring(dash + 1), out rid) ? rid : 0;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
    }
}
