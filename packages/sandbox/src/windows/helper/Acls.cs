using System;
using System.Collections.Generic;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;

namespace Encode.Sandbox
{
    /// <summary>
    /// The folders a sandboxed command may write: an allow entry for the sandbox's SID, inherited by everything in
    /// the folder, so that files made later are covered and the ones already there are covered once it has been
    /// applied. Settings the sandbox must not change (git's hooks and configuration, eNCode's own files) get a deny
    /// entry for the same SID. Windows applies the entry to the whole tree before the call returns.
    /// </summary>
    internal static class Acls
    {
        private const InheritanceFlags Both = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;

        private static readonly FileSystemRights Writable = FileSystemRights.Modify | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.Synchronize;

        private static readonly FileSystemRights Protected = FileSystemRights.Write | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;

        /// <summary>Whether the folder carries the allow entry for the SID.</summary>
        public static bool Has(string path, SecurityIdentifier sid)
        {
            DirectorySecurity security = new DirectoryInfo(path).GetAccessControl(AccessControlSections.Access);
            foreach (FileSystemAccessRule rule in security.GetAccessRules(true, false, typeof(SecurityIdentifier)))
            {
                if (rule.AccessControlType != AccessControlType.Allow || !rule.IdentityReference.Equals(sid)) continue;
                if ((rule.FileSystemRights & Writable) == Writable && (rule.InheritanceFlags & Both) == Both) return true;
            }
            return false;
        }

        public static void Grant(string path, SecurityIdentifier sid, IList<string> protect)
        {
            DirectoryInfo directory = new DirectoryInfo(path);
            if (!directory.Exists) throw new SandboxException("Not a folder: " + path);
            DirectorySecurity security = directory.GetAccessControl(AccessControlSections.Access);
            security.AddAccessRule(new FileSystemAccessRule(sid, Writable, Both, PropagationFlags.None, AccessControlType.Allow));
            directory.SetAccessControl(security);
            foreach (string item in protect) Deny(item, sid);
        }

        public static void Revoke(string path, SecurityIdentifier sid, IList<string> protect)
        {
            foreach (string item in protect) Forget(item, sid);
            DirectoryInfo directory = new DirectoryInfo(path);
            if (!directory.Exists) return;
            DirectorySecurity security = directory.GetAccessControl(AccessControlSections.Access);
            security.RemoveAccessRuleAll(new FileSystemAccessRule(sid, Writable, Both, PropagationFlags.None, AccessControlType.Allow));
            directory.SetAccessControl(security);
        }

        /// <summary>A path that does not exist yet has nothing to protect: the entry cannot be put on it.</summary>
        private static void Deny(string path, SecurityIdentifier sid)
        {
            if (Directory.Exists(path))
            {
                DirectoryInfo directory = new DirectoryInfo(path);
                DirectorySecurity security = directory.GetAccessControl(AccessControlSections.Access);
                security.AddAccessRule(new FileSystemAccessRule(sid, Protected, Both, PropagationFlags.None, AccessControlType.Deny));
                directory.SetAccessControl(security);
            }
            else if (File.Exists(path))
            {
                FileInfo file = new FileInfo(path);
                FileSecurity security = file.GetAccessControl(AccessControlSections.Access);
                security.AddAccessRule(new FileSystemAccessRule(sid, Protected, AccessControlType.Deny));
                file.SetAccessControl(security);
            }
        }

        private static void Forget(string path, SecurityIdentifier sid)
        {
            if (Directory.Exists(path))
            {
                DirectoryInfo directory = new DirectoryInfo(path);
                DirectorySecurity security = directory.GetAccessControl(AccessControlSections.Access);
                security.RemoveAccessRuleAll(new FileSystemAccessRule(sid, Protected, Both, PropagationFlags.None, AccessControlType.Deny));
                directory.SetAccessControl(security);
            }
            else if (File.Exists(path))
            {
                FileInfo file = new FileInfo(path);
                FileSecurity security = file.GetAccessControl(AccessControlSections.Access);
                security.RemoveAccessRuleAll(new FileSystemAccessRule(sid, Protected, AccessControlType.Deny));
                file.SetAccessControl(security);
            }
        }
    }
}
