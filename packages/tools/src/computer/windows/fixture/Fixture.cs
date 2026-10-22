using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

/// <summary>
/// A small window for the desktop helper's tests, and not part of eNCode: a form with the controls an agent meets
/// (text boxes, a password box, buttons, a check box, a list, a combo box, a modal dialog) and a canvas that logs
/// every mouse event it receives. After every change it writes what happened to a file, so a test can check what
/// the helper really did to a real window instead of trusting what the helper says it did.
/// Command line: state-file [left top [title]].
/// A test can also write a command to "state-file.cmd": move DX DY, minimize, restore or close.
/// </summary>
namespace Encode.Fixture
{
    internal static class Program
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [STAThread]
        private static void Main(string[] args)
        {
            SetProcessDPIAware();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            string state = args.Length > 0 ? args[0] : "fixture-state.json";
            int left = args.Length > 1 ? int.Parse(args[1], CultureInfo.InvariantCulture) : 40;
            int top = args.Length > 2 ? int.Parse(args[2], CultureInfo.InvariantCulture) : 40;
            string title = args.Length > 3 ? args[3] : "eNCode Fixture";
            Application.Run(new FixtureForm(state, left, top, title));
        }
    }

    /// <summary>A plain area that logs the mouse in screen pixels.</summary>
    internal sealed class Canvas : Panel
    {
        private readonly FixtureForm form;

        public Canvas(FixtureForm form)
        {
            this.form = form;
            DoubleBuffered = true;
            BackColor = Color.FromArgb(200, 220, 255);
            // A clicked canvas takes the keyboard focus, so the wheel goes to it however Windows routes it.
            SetStyle(ControlStyles.Selectable, true);
            TabStop = true;
        }

        private static string Button(MouseButtons button)
        {
            return button == MouseButtons.Left ? "left" : button == MouseButtons.Right ? "right" : button == MouseButtons.Middle ? "middle" : button.ToString().ToLowerInvariant();
        }

        private string At(MouseEventArgs e)
        {
            Point screen = PointToScreen(e.Location);
            return screen.X.ToString(CultureInfo.InvariantCulture) + "," + screen.Y.ToString(CultureInfo.InvariantCulture);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            Focus();
            form.Log("down " + At(e) + " " + Button(e.Button));
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            form.Log("up " + At(e) + " " + Button(e.Button));
        }

        protected override void OnMouseDoubleClick(MouseEventArgs e)
        {
            base.OnMouseDoubleClick(e);
            form.Log("double " + At(e) + " " + Button(e.Button));
        }

        protected override void OnMouseWheel(MouseEventArgs e)
        {
            base.OnMouseWheel(e);
            form.Log("wheel " + At(e) + " " + e.Delta.ToString(CultureInfo.InvariantCulture));
        }

        protected override void WndProc(ref Message m)
        {
            const int WM_MOUSEHWHEEL = 0x020E;
            if (m.Msg == WM_MOUSEHWHEEL)
            {
                int delta = (short)((m.WParam.ToInt64() >> 16) & 0xFFFF);
                form.Log("hwheel " + delta.ToString(CultureInfo.InvariantCulture));
            }
            base.WndProc(ref m);
        }
    }

    internal sealed class FixtureForm : Form
    {
        private readonly string statePath;
        private readonly TextBox notes = new TextBox();
        private readonly TextBox subject = new TextBox();
        private readonly TextBox secret = new TextBox();
        private readonly Button add = new Button();
        private readonly Button openDialog = new Button();
        private readonly CheckBox remember = new CheckBox();
        private readonly ComboBox color = new ComboBox();
        private readonly ListBox items = new ListBox();
        private readonly Label status = new Label();
        private readonly Canvas canvas;
        private readonly List<string> events = new List<string>();
        private readonly Timer later = new Timer();
        private readonly Timer commands = new Timer();
        private int activated;
        private int counter;
        private bool dialogOpen;
        private string lastPolled = "";

        public FixtureForm(string statePath, int left, int top, string title)
        {
            this.statePath = statePath;
            Text = title;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(left, top);
            ClientSize = new Size(640, 440);
            FormBorderStyle = FormBorderStyle.Sizable;
            BackColor = Color.FromArgb(250, 245, 235);
            KeyPreview = true;

            Label notesLabel = new Label { Text = "Notes:", Location = new Point(10, 8), Size = new Size(120, 18) };
            notes.AccessibleName = "Notes";
            notes.Multiline = true;
            notes.AcceptsReturn = true;
            notes.AcceptsTab = true;
            notes.Location = new Point(10, 28);
            notes.Size = new Size(290, 84);
            notes.TextChanged += delegate { Soon(); };

            Label secretLabel = new Label { Text = "Secret:", Location = new Point(320, 8), Size = new Size(120, 18) };
            secret.AccessibleName = "Secret";
            secret.UseSystemPasswordChar = true;
            secret.Location = new Point(320, 28);
            secret.Size = new Size(220, 24);
            secret.TextChanged += delegate { Soon(); };

            // A single line, which (unlike the multi-line Notes) has a value that can be set whole.
            Label subjectLabel = new Label { Text = "Subject:", Location = new Point(320, 60), Size = new Size(120, 18) };
            subject.AccessibleName = "Subject";
            subject.Location = new Point(320, 80);
            subject.Size = new Size(220, 24);
            subject.TextChanged += delegate { Soon(); };

            add.Text = "Add item";
            add.Location = new Point(10, 122);
            add.Size = new Size(100, 28);
            add.Click += delegate
            {
                counter++;
                items.Items.Add("Item " + counter.ToString(CultureInfo.InvariantCulture));
                status.Text = "Added Item " + counter.ToString(CultureInfo.InvariantCulture);
                Write();
            };

            openDialog.Text = "Open dialog";
            openDialog.Location = new Point(120, 122);
            openDialog.Size = new Size(110, 28);
            openDialog.Click += delegate { ShowDialogBox(); };

            remember.Text = "Remember me";
            remember.Location = new Point(244, 126);
            remember.Size = new Size(130, 22);
            remember.CheckedChanged += delegate { Write(); };

            color.AccessibleName = "Color";
            color.DropDownStyle = ComboBoxStyle.DropDownList;
            color.Items.AddRange(new object[] { "Red", "Green", "Blue" });
            color.Location = new Point(400, 124);
            color.Size = new Size(110, 24);
            color.SelectedIndexChanged += delegate { Write(); };

            items.AccessibleName = "Items";
            items.Location = new Point(10, 162);
            items.Size = new Size(200, 120);
            items.SelectedIndexChanged += delegate { Write(); };

            status.Text = "Ready";
            status.Location = new Point(10, 292);
            status.Size = new Size(600, 20);

            canvas = new Canvas(this);
            canvas.Location = new Point(230, 162);
            canvas.Size = new Size(380, 200);
            ContextMenuStrip menu = new ContextMenuStrip();
            ToolStripItem action = menu.Items.Add("Canvas action");
            action.Click += delegate { Log("menu Canvas action"); };
            canvas.ContextMenuStrip = menu;

            Controls.AddRange(new Control[] { notesLabel, notes, secretLabel, secret, subjectLabel, subject, add, openDialog, remember, color, items, status, canvas });

            Activated += delegate
            {
                activated++;
                Write();
            };
            Shown += delegate { Write(); };
            Move += delegate { Write(); };
            Resize += delegate { Write(); };
            KeyDown += OnFixtureKey;

            later.Interval = 40;
            later.Tick += delegate
            {
                later.Stop();
                Write();
            };
            commands.Interval = 100;
            commands.Tick += delegate
            {
                RunCommand();
                Poll();
            };
            commands.Start();
        }

        /// <summary>
        /// A list item selected through UI Automation is selected without the control telling the form, so the record is also
        /// written when what it shows has changed since it was last written.
        /// </summary>
        private void Poll()
        {
            string now = items.SelectedIndex.ToString(CultureInfo.InvariantCulture) + "|" + color.SelectedIndex.ToString(CultureInfo.InvariantCulture) + "|" + (ContainsFocus ? "1" : "0");
            if (now == lastPolled) return;
            lastPolled = now;
            Write();
        }

        /// <summary>Typing writes a change per character; one record per moment is enough.</summary>
        private void Soon()
        {
            if (!later.Enabled) later.Start();
        }

        private void RunCommand()
        {
            string file = statePath + ".cmd";
            if (!File.Exists(file)) return;
            string command;
            try
            {
                command = File.ReadAllText(file).Trim();
                File.Delete(file);
            }
            catch (IOException)
            {
                return;
            }
            string[] parts = command.Split(' ');
            if (parts[0] == "move" && parts.Length == 3)
            {
                Location = new Point(Left + int.Parse(parts[1], CultureInfo.InvariantCulture), Top + int.Parse(parts[2], CultureInfo.InvariantCulture));
            }
            else if (parts[0] == "minimize")
            {
                WindowState = FormWindowState.Minimized;
            }
            else if (parts[0] == "restore")
            {
                WindowState = FormWindowState.Normal;
            }
            else if (parts[0] == "close")
            {
                Close();
            }
            Write();
        }

        private static bool IsModifier(Keys key)
        {
            return key == Keys.ControlKey || key == Keys.ShiftKey || key == Keys.Menu || key == Keys.LControlKey || key == Keys.RControlKey || key == Keys.LShiftKey || key == Keys.RShiftKey || key == Keys.LMenu || key == Keys.RMenu;
        }

        /// <summary>Records the keys that are shortcuts, not the letters that are typed.</summary>
        private void OnFixtureKey(object sender, KeyEventArgs e)
        {
            if (IsModifier(e.KeyCode)) return;
            bool listed = e.Control || e.Alt || e.KeyCode == Keys.Escape || (e.KeyCode >= Keys.F1 && e.KeyCode <= Keys.F24);
            if (!listed) return;
            StringBuilder sb = new StringBuilder("key ");
            if (e.Control) sb.Append("ctrl+");
            if (e.Alt) sb.Append("alt+");
            if (e.Shift) sb.Append("shift+");
            sb.Append(e.KeyCode.ToString());
            Log(sb.ToString());
        }

        private void ShowDialogBox()
        {
            using (Form dialog = new Form())
            {
                dialog.Text = "Fixture dialog";
                dialog.FormBorderStyle = FormBorderStyle.FixedDialog;
                dialog.MinimizeBox = false;
                dialog.MaximizeBox = false;
                dialog.ShowInTaskbar = false;
                dialog.StartPosition = FormStartPosition.CenterParent;
                dialog.ClientSize = new Size(320, 120);
                TextBox field = new TextBox { AccessibleName = "Dialog name", Location = new Point(10, 10), Size = new Size(290, 24) };
                Button close = new Button { Text = "Close dialog", Location = new Point(10, 60), Size = new Size(120, 28) };
                close.Click += delegate { dialog.Close(); };
                dialog.Controls.Add(field);
                dialog.Controls.Add(close);
                dialogOpen = true;
                Write();
                dialog.ShowDialog(this);
                dialogOpen = false;
                Write();
            }
        }

        public void Log(string line)
        {
            events.Add(line);
            if (events.Count > 400) events.RemoveRange(0, events.Count - 400);
            Write();
        }

        private static string Quote(string text)
        {
            StringBuilder sb = new StringBuilder("\"");
            foreach (char c in text ?? "")
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20 || c > 0x7e) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.Append('"').ToString();
        }

        private static string Rect(Rectangle rect)
        {
            return "[" + rect.X.ToString(CultureInfo.InvariantCulture) + "," + rect.Y.ToString(CultureInfo.InvariantCulture) + "," + rect.Width.ToString(CultureInfo.InvariantCulture) + "," + rect.Height.ToString(CultureInfo.InvariantCulture) + "]";
        }

        private void Write()
        {
            if (!IsHandleCreated) return;
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"pid\":").Append(System.Diagnostics.Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"title\":").Append(Quote(Text));
            sb.Append(",\"activated\":").Append(activated.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"focused\":").Append(ContainsFocus ? "true" : "false");
            sb.Append(",\"dialogOpen\":").Append(dialogOpen ? "true" : "false");
            sb.Append(",\"minimized\":").Append(WindowState == FormWindowState.Minimized ? "true" : "false");
            sb.Append(",\"box\":").Append(Rect(Bounds));
            sb.Append(",\"canvas\":").Append(Rect(canvas.RectangleToScreen(canvas.ClientRectangle)));
            sb.Append(",\"notes\":").Append(Quote(notes.Text));
            sb.Append(",\"subject\":").Append(Quote(subject.Text));
            sb.Append(",\"secret\":").Append(Quote(secret.Text));
            sb.Append(",\"remember\":").Append(remember.Checked ? "true" : "false");
            sb.Append(",\"color\":").Append(Quote(color.SelectedItem == null ? "" : color.SelectedItem.ToString()));
            sb.Append(",\"selected\":").Append(Quote(items.SelectedItem == null ? "" : items.SelectedItem.ToString()));
            sb.Append(",\"status\":").Append(Quote(status.Text));
            sb.Append(",\"items\":[");
            for (int n = 0; n < items.Items.Count; n++)
            {
                if (n > 0) sb.Append(',');
                sb.Append(Quote(items.Items[n].ToString()));
            }
            sb.Append("],\"events\":[");
            for (int n = 0; n < events.Count; n++)
            {
                if (n > 0) sb.Append(',');
                sb.Append(Quote(events[n]));
            }
            sb.Append("]}");
            try
            {
                string temporary = statePath + ".tmp";
                File.WriteAllText(temporary, sb.ToString(), new UTF8Encoding(false));
                File.Copy(temporary, statePath, true);
            }
            catch (IOException)
            {
                // A test reading the file at this moment: the next change writes it again.
            }
        }
    }
}
