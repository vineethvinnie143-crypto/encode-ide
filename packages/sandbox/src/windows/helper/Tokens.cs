using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;

namespace Encode.Sandbox
{
    /// <summary>
    /// The token a sandboxed command runs under: the caller's own, restricted so that it can write only where one of
    /// the restricting SIDs is allowed to. Reading is not restricted. The caller's privileges are dropped and an
    /// administrator's group is turned into deny-only.
    /// </summary>
    internal static class Tokens
    {
        public static IntPtr OpenOwn()
        {
            IntPtr token;
            if (!Native.OpenProcessToken(Native.GetCurrentProcess(), Native.TOKEN_ALL_ACCESS, out token)) throw SandboxException.Last("OpenProcessToken");
            return token;
        }

        public static IntPtr Restrict(IntPtr token, IList<SecurityIdentifier> restricting, bool writeRestricted, bool lua)
        {
            if (restricting.Count == 0) throw new SandboxException("At least one restricting SID is needed.");
            int size = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
            IntPtr array = Marshal.AllocHGlobal(size * restricting.Count);
            List<IntPtr> sids = new List<IntPtr>();
            try
            {
                for (int i = 0; i < restricting.Count; i++)
                {
                    IntPtr sid = Sids.ToUnmanaged(restricting[i]);
                    sids.Add(sid);
                    SID_AND_ATTRIBUTES entry = new SID_AND_ATTRIBUTES();
                    entry.Sid = sid;
                    entry.Attributes = 0;
                    Marshal.StructureToPtr(entry, new IntPtr(array.ToInt64() + i * size), false);
                }
                uint flags = Native.DISABLE_MAX_PRIVILEGE;
                if (writeRestricted) flags |= Native.WRITE_RESTRICTED;
                if (lua) flags |= Native.LUA_TOKEN;
                IntPtr restricted;
                if (!Native.CreateRestrictedToken(token, flags, 0, IntPtr.Zero, 0, IntPtr.Zero, (uint)restricting.Count, array, out restricted)) throw SandboxException.Last("CreateRestrictedToken");
                return restricted;
            }
            finally
            {
                foreach (IntPtr sid in sids) Marshal.FreeHGlobal(sid);
                Marshal.FreeHGlobal(array);
            }
        }

        /// <summary>
        /// What the new token's objects (pipes, processes, sections the command makes) are open to. Without this they
        /// belong to the restricted token's own default, which the restricted half of every check would refuse.
        /// </summary>
        public static void SetDefaultDacl(IntPtr token, IList<SecurityIdentifier> allowed)
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
