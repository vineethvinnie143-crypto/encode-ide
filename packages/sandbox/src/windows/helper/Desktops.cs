using System;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace Encode.Sandbox
{
    /// <summary>
    /// A window station and desktop of the sandboxed program's own. A program at a lower integrity level than the
    /// desktop it starts on can be refused the windowing library's start-up (0xC0000142), and the person's desktop
    /// belongs to the person. This one is made for the program: only the person and the system may use it, and it is
    /// labeled low, so a program at the low level can start on it and nothing on the person's desktop is reachable.
    /// </summary>
    internal sealed class PrivateDesktop : IDisposable
    {
        private IntPtr station = IntPtr.Zero;
        private IntPtr desktop = IntPtr.Zero;

        /// <summary>"station\desktop", as a program is told where to start.</summary>
        public string Name;

        public static PrivateDesktop Create(bool ownStation, SecurityIdentifier user)
        {
            PrivateDesktop made = new PrivateDesktop();
            try
            {
                made.Open(ownStation, user);
                return made;
            }
            catch
            {
                made.Dispose();
                throw;
            }
        }

        private void Open(bool ownStation, SecurityIdentifier user)
        {
            string text = "D:(A;;GA;;;" + user.Value + ")(A;;GA;;;SY)S:(ML;;NW;;;LW)";
            IntPtr descriptor;
            uint size;
            if (!Native.ConvertStringSecurityDescriptorToSecurityDescriptor(text, Native.SDDL_REVISION_1, out descriptor, out size)) throw SandboxException.Last("ConvertStringSecurityDescriptorToSecurityDescriptor");
            IntPtr attributes = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)));
            IntPtr original = IntPtr.Zero;
            try
            {
                SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
                sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
                sa.lpSecurityDescriptor = descriptor;
                sa.bInheritHandle = 0;
                Marshal.StructureToPtr(sa, attributes, false);
                string id = Guid.NewGuid().ToString("N");
                string stationName;
                original = Native.GetProcessWindowStation();
                if (ownStation)
                {
                    stationName = "encode-" + id;
                    station = Native.CreateWindowStation(stationName, 0, Native.GENERIC_ALL, attributes);
                    if (station == IntPtr.Zero) throw SandboxException.Last("CreateWindowStation");
                    // The desktop is made in the window station this process is on, so for a moment it is on the new one.
                    if (!Native.SetProcessWindowStation(station)) throw SandboxException.Last("SetProcessWindowStation");
                }
                else
                {
                    stationName = NameOf(original);
                }
                desktop = Native.CreateDesktop("encode-" + id, null, IntPtr.Zero, 0, Native.GENERIC_ALL, attributes);
                if (desktop == IntPtr.Zero) throw SandboxException.Last("CreateDesktop");
                Name = stationName + "\\encode-" + id;
            }
            finally
            {
                if (ownStation && original != IntPtr.Zero) Native.SetProcessWindowStation(original);
                Marshal.FreeHGlobal(attributes);
                Native.LocalFree(descriptor);
            }
        }

        public void Dispose()
        {
            if (desktop != IntPtr.Zero)
            {
                Native.CloseDesktop(desktop);
                desktop = IntPtr.Zero;
            }
            if (station != IntPtr.Zero)
            {
                Native.CloseWindowStation(station);
                station = IntPtr.Zero;
            }
        }

        private static string NameOf(IntPtr handle)
        {
            uint needed;
            Native.GetUserObjectInformation(handle, Native.UOI_NAME, IntPtr.Zero, 0, out needed);
            if (needed == 0) return "";
            IntPtr buffer = Marshal.AllocHGlobal((int)needed);
            try
            {
                if (!Native.GetUserObjectInformation(handle, Native.UOI_NAME, buffer, needed, out needed)) return "";
                return Marshal.PtrToStringUni(buffer) ?? "";
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static string SecurityOf(IntPtr handle, uint information)
        {
            uint needed;
            Native.GetUserObjectSecurity(handle, ref information, IntPtr.Zero, 0, out needed);
            if (needed == 0) return "unreadable (error " + Marshal.GetLastWin32Error() + ")";
            IntPtr buffer = Marshal.AllocHGlobal((int)needed);
            try
            {
                if (!Native.GetUserObjectSecurity(handle, ref information, buffer, needed, out needed)) return "unreadable (error " + Marshal.GetLastWin32Error() + ")";
                IntPtr text;
                uint length;
                if (!Native.ConvertSecurityDescriptorToStringSecurityDescriptor(buffer, Native.SDDL_REVISION_1, information, out text, out length)) return "unconvertible (error " + Marshal.GetLastWin32Error() + ")";
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
                Marshal.FreeHGlobal(buffer);
            }
        }

        /// <summary>The window station and desktop this process is on, and who may use them (for the measurement).</summary>
        public static string Describe()
        {
            IntPtr station = Native.GetProcessWindowStation();
            IntPtr desktop = Native.GetThreadDesktop(Native.GetCurrentThreadId());
            uint all = Native.OWNER_SECURITY_INFORMATION | Native.DACL_SECURITY_INFORMATION | Native.LABEL_SECURITY_INFORMATION;
            uint plain = Native.OWNER_SECURITY_INFORMATION | Native.DACL_SECURITY_INFORMATION;
            JsonObject json = new JsonObject();
            json.Text("station", NameOf(station));
            json.Text("stationSecurity", SecurityOf(station, all));
            json.Text("stationSecurityWithoutLabel", SecurityOf(station, plain));
            json.Text("desktop", NameOf(desktop));
            json.Text("desktopSecurity", SecurityOf(desktop, all));
            json.Text("desktopSecurityWithoutLabel", SecurityOf(desktop, plain));
            return json.ToString();
        }
    }
}
