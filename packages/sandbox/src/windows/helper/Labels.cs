using System;
using System.Runtime.InteropServices;

namespace Encode.Sandbox
{
    /// <summary>
    /// Integrity labels. A program at the low integrity level cannot write, delete or change the permissions of
    /// anything labeled higher, and nothing is labeled higher than the medium level unless it is meant to be; so the
    /// folders a sandboxed command may change are labeled low (inherited by everything in them, now and later, see
    /// LabelWalker), and what it must not change inside them (git's hooks and configuration, the project's own
    /// settings) is labeled medium again, explicitly, so that it does not take its parent's label.
    /// </summary>
    internal static class Labels
    {
        /// <summary>A security descriptor that holds only the label, from its text. Free it with Native.LocalFree.</summary>
        public static IntPtr Descriptor(string text)
        {
            IntPtr descriptor;
            uint size;
            if (!Native.ConvertStringSecurityDescriptorToSecurityDescriptor(text, Native.SDDL_REVISION_1, out descriptor, out size)) throw SandboxException.Last("ConvertStringSecurityDescriptorToSecurityDescriptor");
            return descriptor;
        }

        /// <summary>
        /// Sets the label of the path to the one in the text (empty: takes it away) through the system's own walk,
        /// which passes a label on to what is in a folder. Meant for the few paths that are protected, not for a project.
        /// </summary>
        public static void Apply(string path, string text)
        {
            IntPtr descriptor = IntPtr.Zero;
            IntPtr sacl = IntPtr.Zero;
            try
            {
                if (text.Length > 0)
                {
                    descriptor = Descriptor(text);
                    bool present;
                    bool defaulted;
                    if (!Native.GetSecurityDescriptorSacl(descriptor, out present, out sacl, out defaulted) || !present) throw new SandboxException("The label has no access control list.");
                }
                uint error = Native.SetNamedSecurityInfo(LabelWalker.Extended(path), Native.SE_FILE_OBJECT, Native.LABEL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
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
            uint error = Native.GetNamedSecurityInfo(LabelWalker.Extended(path), Native.SE_FILE_OBJECT, Native.LABEL_SECURITY_INFORMATION, out owner, out group, out dacl, out sacl, out descriptor);
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

        /// <summary>Whether the folder carries the low label for what is in it (set by the walk, and set last).</summary>
        public static bool IsLow(string path)
        {
            string label = Get(path);
            return label.Contains("OICI") && label.Contains(";NW;;;LW)") && !label.Contains("ID;NW");
        }

        /// <summary>
        /// Gives the path a medium label of its own, so that a program at the low integrity level cannot change it
        /// even inside a folder that is labeled low. Returns false when there is nothing at the path.
        /// </summary>
        public static bool Protect(string path)
        {
            bool folder;
            if (!LabelWalker.Exists(path, out folder)) return false;
            string label = Get(path);
            // Its own label (not one passed down by the folder it is in) and the medium level: nothing to do.
            if (label.Contains(";NW;;;ME)") && !label.Contains("ID;NW")) return true;
            Apply(path, folder ? "S:(ML;OICI;NW;;;ME)" : "S:(ML;;NW;;;ME)");
            return true;
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
    }
}
