using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

namespace Encode.Sandbox
{
    /// <summary>
    /// Integrity labels on folders. A program at the low integrity level cannot write, delete, rename or change the
    /// permissions of anything labeled higher, and nothing is labeled higher than the medium level unless it is
    /// meant to be; so the folders a sandboxed command may change are labeled low (inherited by everything in
    /// them, now and later), and what it must not change inside them (git's hooks and configuration) is labeled
    /// medium again and told not to take its parent's label.
    /// </summary>
    internal static class Labels
    {
        private static string Alias(string level)
        {
            switch (level)
            {
                case "low": return "LW";
                case "medium": return "ME";
                default: throw new SandboxException("Unknown integrity level: " + level);
            }
        }

        /// <summary>
        /// Gives the path the level (empty: takes its label away). A folder passes it to what is in it. A label the
        /// path carries itself is kept when its parent's label is passed down, which is how a path inside a labeled
        /// folder keeps another one.
        /// </summary>
        public static void Apply(string path, string level)
        {
            IntPtr descriptor = IntPtr.Zero;
            IntPtr sacl = IntPtr.Zero;
            try
            {
                if (level.Length > 0)
                {
                    string inherit = Directory.Exists(path) ? "OICI" : "";
                    string text = "S:(ML;" + inherit + ";NW;;;" + Alias(level) + ")";
                    uint size;
                    if (!Native.ConvertStringSecurityDescriptorToSecurityDescriptor(text, Native.SDDL_REVISION_1, out descriptor, out size)) throw SandboxException.Last("ConvertStringSecurityDescriptorToSecurityDescriptor");
                    bool present;
                    bool defaulted;
                    if (!Native.GetSecurityDescriptorSacl(descriptor, out present, out sacl, out defaulted) || !present) throw new SandboxException("The label has no access control list.");
                }
                uint error = Native.SetNamedSecurityInfo(path, Native.SE_FILE_OBJECT, Native.LABEL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
                if (error != 0) throw new SandboxException("SetNamedSecurityInfo(" + path + ")", (int)error);
            }
            finally
            {
                if (descriptor != IntPtr.Zero) Native.LocalFree(descriptor);
            }
        }

        /// <summary>The path's label in the text form Windows uses ("S:(ML;OICI;NW;;;LW)"), or empty when it has none.</summary>
        public static string Get(string path)
        {
            IntPtr owner;
            IntPtr group;
            IntPtr dacl;
            IntPtr sacl;
            IntPtr descriptor;
            uint error = Native.GetNamedSecurityInfo(path, Native.SE_FILE_OBJECT, Native.LABEL_SECURITY_INFORMATION, out owner, out group, out dacl, out sacl, out descriptor);
            if (error != 0) throw new SandboxException("GetNamedSecurityInfo(" + path + ")", (int)error);
            try
            {
                IntPtr text;
                uint length;
                if (!Native.ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor, Native.SDDL_REVISION_1, Native.LABEL_SECURITY_INFORMATION, out text, out length)) throw SandboxException.Last("ConvertSecurityDescriptorToStringSecurityDescriptor");
                try
                {
                    return Marshal.PtrToStringUni(text) ?? "";
                }
                finally
                {
                    Native.LocalFree(text);
                }
            }
            finally
            {
                Native.LocalFree(descriptor);
            }
        }

        /// <summary>Who owns a running program, who may open it and the label it carries, in the text form Windows uses (for the measurement).</summary>
        public static string OfProcess(int pid)
        {
            IntPtr process = Native.OpenProcess(Native.READ_CONTROL | Native.PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
            if (process == IntPtr.Zero) throw SandboxException.Last("OpenProcess(" + pid + ")");
            try
            {
                IntPtr owner;
                IntPtr group;
                IntPtr dacl;
                IntPtr sacl;
                IntPtr descriptor;
                uint information = Native.OWNER_SECURITY_INFORMATION | Native.DACL_SECURITY_INFORMATION | Native.LABEL_SECURITY_INFORMATION;
                uint error = Native.GetSecurityInfo(process, Native.SE_KERNEL_OBJECT, information, out owner, out group, out dacl, out sacl, out descriptor);
                if (error != 0) throw new SandboxException("GetSecurityInfo(" + pid + ")", (int)error);
                try
                {
                    IntPtr text;
                    uint length;
                    if (!Native.ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor, Native.SDDL_REVISION_1, information, out text, out length)) throw SandboxException.Last("ConvertSecurityDescriptorToStringSecurityDescriptor");
                    try
                    {
                        return Marshal.PtrToStringUni(text) ?? "";
                    }
                    finally
                    {
                        Native.LocalFree(text);
                    }
                }
                finally
                {
                    Native.LocalFree(descriptor);
                }
            }
            finally
            {
                Native.CloseHandle(process);
            }
        }

        /// <summary>Whether the folder carries the low label for what is in it.</summary>
        public static bool IsLow(string path)
        {
            string label = Get(path);
            return label.Contains("OICI") && label.Contains(";NW;;;LW)");
        }
    }
}
