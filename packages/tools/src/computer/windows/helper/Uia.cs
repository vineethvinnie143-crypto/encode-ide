using System;
using System.Collections.Generic;
using System.Threading;
using System.Windows;
using System.Windows.Automation;

namespace Encode.Desktop
{
    /// <summary>
    /// Runs a call to another program's accessibility provider on a thread of its own and stops waiting when it
    /// takes too long. A provider that hangs (a program showing a modal dialog from inside a call, a frozen
    /// window) must cost one call, not the helper; the abandoned thread ends whenever the program answers.
    /// </summary>
    internal static class Worker
    {
        private static int abandoned;

        public static int Abandoned { get { return Thread.VolatileRead(ref abandoned); } }

        public static T Run<T>(Func<T> work, int timeoutMs, string what, Cancel cancel)
        {
            return RunIn<T>(ApartmentState.MTA, work, timeoutMs, what, cancel);
        }

        /// <summary>For the shell's own objects, which live in a single-threaded apartment.</summary>
        public static T RunSta<T>(Func<T> work, int timeoutMs, string what, Cancel cancel)
        {
            return RunIn<T>(ApartmentState.STA, work, timeoutMs, what, cancel);
        }

        private static T RunIn<T>(ApartmentState apartment, Func<T> work, int timeoutMs, string what, Cancel cancel)
        {
            T result = default(T);
            Exception error = null;
            ManualResetEventSlim done = new ManualResetEventSlim(false);
            Thread thread = new Thread(delegate()
            {
                try
                {
                    result = work();
                }
                catch (Exception e)
                {
                    error = e;
                }
                finally
                {
                    done.Set();
                }
            });
            thread.IsBackground = true;
            thread.Name = "encode-uia";
            thread.SetApartmentState(apartment);
            thread.Start();
            int waited = 0;
            while (!done.Wait(50))
            {
                waited += 50;
                if (cancel != null && cancel.IsCancelled)
                {
                    Interlocked.Increment(ref abandoned);
                    throw new HelperException("failed", "Cancelled.");
                }
                if (waited >= timeoutMs)
                {
                    Interlocked.Increment(ref abandoned);
                    throw new HelperException("hung", what + " did not answer within " + (timeoutMs / 1000.0).ToString("0.#", System.Globalization.CultureInfo.InvariantCulture) + " seconds. The application is busy, frozen or showing a dialog.");
                }
            }
            if (error != null) throw Map(error, what);
            return result;
        }

        public static void Run(Action work, int timeoutMs, string what, Cancel cancel)
        {
            Run<bool>(delegate()
            {
                work();
                return true;
            }, timeoutMs, what, cancel);
        }

        public static HelperException Map(Exception error, string what)
        {
            HelperException known = error as HelperException;
            if (known != null) return known;
            if (error is ElementNotAvailableException) return new HelperException("stale-element", "The element is no longer there.");
            if (error is ElementNotEnabledException) return new HelperException("failed", "The element is disabled.");
            string message = string.IsNullOrEmpty(error.Message) ? error.GetType().Name : error.Message;
            return new HelperException("failed", what + " failed: " + message);
        }
    }

    internal sealed class ElementEntry
    {
        public string Ref;
        public string Key;
        public AutomationElement Element;
        public string WindowId;
        public string Role;
        public string Name;
    }

    /// <summary>What an element is right now, asked just before it is used.</summary>
    internal sealed class ElementNow
    {
        public Box Box;
        public bool Enabled;
        public bool Offscreen;
        public bool Invoke;
        public bool Toggle;
        public bool Select;
        public bool Expand;
        public bool Value;
        public bool ValueReadOnly;
        public bool Range;
        public bool Password;
        public bool CanFocus;
    }

    /// <summary>
    /// The window's accessibility tree: the outline the model reads, and the handles the helper keeps so that
    /// a ref the model names later still means the element it was given for.
    /// </summary>
    internal sealed class UiaService
    {
        private const int TableLimit = 8000;
        private const int SiblingLimit = 1000;

        private static readonly Dictionary<int, string> Roles = BuildRoles();

        private readonly Dictionary<string, string> refOf = new Dictionary<string, string>();
        private readonly Dictionary<string, ElementEntry> byRef = new Dictionary<string, ElementEntry>();
        private readonly Queue<string> order = new Queue<string>();
        private int counter;

        private static Dictionary<int, string> BuildRoles()
        {
            Dictionary<int, string> map = new Dictionary<int, string>();
            map[ControlType.Button.Id] = "button";
            map[ControlType.Calendar.Id] = "table";
            map[ControlType.CheckBox.Id] = "checkbox";
            map[ControlType.ComboBox.Id] = "combobox";
            map[ControlType.Custom.Id] = "group";
            map[ControlType.DataGrid.Id] = "table";
            map[ControlType.DataItem.Id] = "row";
            map[ControlType.Document.Id] = "document";
            map[ControlType.Edit.Id] = "edit";
            map[ControlType.Group.Id] = "group";
            map[ControlType.Header.Id] = "header";
            map[ControlType.HeaderItem.Id] = "header";
            map[ControlType.Hyperlink.Id] = "link";
            map[ControlType.Image.Id] = "image";
            map[ControlType.List.Id] = "list";
            map[ControlType.ListItem.Id] = "listitem";
            map[ControlType.Menu.Id] = "menu";
            map[ControlType.MenuBar.Id] = "menubar";
            map[ControlType.MenuItem.Id] = "menuitem";
            map[ControlType.Pane.Id] = "pane";
            map[ControlType.ProgressBar.Id] = "progress";
            map[ControlType.RadioButton.Id] = "radio";
            map[ControlType.Slider.Id] = "slider";
            map[ControlType.Spinner.Id] = "spinner";
            map[ControlType.SplitButton.Id] = "button";
            map[ControlType.StatusBar.Id] = "statusbar";
            map[ControlType.Tab.Id] = "tab";
            map[ControlType.TabItem.Id] = "tabitem";
            map[ControlType.Table.Id] = "table";
            map[ControlType.Text.Id] = "text";
            map[ControlType.TitleBar.Id] = "titlebar";
            map[ControlType.ToolBar.Id] = "toolbar";
            map[ControlType.ToolTip.Id] = "tooltip";
            map[ControlType.Tree.Id] = "tree";
            map[ControlType.TreeItem.Id] = "treeitem";
            map[ControlType.Window.Id] = "window";
            // Control types newer than the managed wrapper knows (AppBar 50040, SemanticZoom 50039) by their numbers.
            map[50040] = "toolbar";
            map[50039] = "pane";
            // ScrollBar, Separator and Thumb are left out: they say nothing the wheel and the keys do not.
            return map;
        }

        private static CacheRequest MakeCache()
        {
            CacheRequest request = new CacheRequest();
            request.AutomationElementMode = AutomationElementMode.Full;
            request.TreeScope = TreeScope.Element;
            request.Add(AutomationElement.NameProperty);
            request.Add(AutomationElement.ControlTypeProperty);
            request.Add(AutomationElement.ClassNameProperty);
            request.Add(AutomationElement.BoundingRectangleProperty);
            request.Add(AutomationElement.IsEnabledProperty);
            request.Add(AutomationElement.IsOffscreenProperty);
            request.Add(AutomationElement.IsPasswordProperty);
            request.Add(AutomationElement.HasKeyboardFocusProperty);
            request.Add(AutomationElement.IsRequiredForFormProperty);
            request.Add(InvokePattern.Pattern);
            request.Add(TogglePattern.Pattern);
            request.Add(TogglePattern.ToggleStateProperty);
            request.Add(SelectionItemPattern.Pattern);
            request.Add(SelectionItemPattern.IsSelectedProperty);
            request.Add(ExpandCollapsePattern.Pattern);
            request.Add(ExpandCollapsePattern.ExpandCollapseStateProperty);
            request.Add(ValuePattern.Pattern);
            request.Add(ValuePattern.ValueProperty);
            request.Add(ValuePattern.IsReadOnlyProperty);
            request.Add(RangeValuePattern.Pattern);
            request.Add(RangeValuePattern.ValueProperty);
            request.Add(RangeValuePattern.IsReadOnlyProperty);
            request.Add(TextPattern.Pattern);
            request.Add(ScrollPattern.Pattern);
            request.Add(ScrollPattern.HorizontallyScrollableProperty);
            request.Add(ScrollPattern.VerticallyScrollableProperty);
            return request;
        }

        public static Box BoxOf(Rect rect)
        {
            if (rect.IsEmpty || double.IsInfinity(rect.X) || double.IsInfinity(rect.Y) || double.IsNaN(rect.X) || double.IsNaN(rect.Y) || double.IsInfinity(rect.Width) || double.IsInfinity(rect.Height)) return Box.Empty;
            int left = (int)Math.Floor(rect.X);
            int top = (int)Math.Floor(rect.Y);
            int right = (int)Math.Ceiling(rect.X + rect.Width);
            int bottom = (int)Math.Ceiling(rect.Y + rect.Height);
            return new Box(left, top, Math.Max(0, right - left), Math.Max(0, bottom - top));
        }

        private static string Clip(string text, int limit)
        {
            if (text == null) return null;
            return text.Length > limit ? text.Substring(0, limit) : text;
        }

        // ---------------------------------------------------------------- reading one element

        private static bool Has<T>(AutomationElement element, AutomationPattern pattern, out T found) where T : class
        {
            object value;
            if (element.TryGetCachedPattern(pattern, out value))
            {
                found = value as T;
                return found != null;
            }
            found = null;
            return false;
        }

        private static NodeInfo Read(AutomationElement element, string windowId)
        {
            NodeInfo node = new NodeInfo();
            node.Native = element;
            AutomationElement.AutomationElementInformation info = element.Cached;
            string cls = info.ClassName ?? "";
            string role = "group";
            ControlType type = info.ControlType;
            if (type != null && !Roles.TryGetValue(type.Id, out role)) role = null;
            if (role == "window" && cls == "#32770") role = "dialog";
            node.Role = role;
            node.Name = Clip(info.Name, 300) ?? "";
            node.Offscreen = info.IsOffscreen;
            node.Password = info.IsPassword;
            node.Focused = info.HasKeyboardFocus;
            node.Box = BoxOf(info.BoundingRectangle);
            try
            {
                int[] runtime = element.GetRuntimeId();
                if (runtime != null && runtime.Length > 0) node.Key = windowId + ":" + string.Join(".", Array.ConvertAll(runtime, delegate(int n) { return n.ToString(System.Globalization.CultureInfo.InvariantCulture); }));
            }
            catch (Exception)
            {
                node.Key = null;
            }

            List<string> states = new List<string>();
            List<string> can = new List<string>();
            bool enabled = info.IsEnabled;
            if (!enabled) states.Add("disabled");
            if (node.Focused) states.Add("focused");

            InvokePattern invoke;
            TogglePattern toggle;
            SelectionItemPattern selection;
            ExpandCollapsePattern expand;
            ValuePattern value;
            RangeValuePattern range;
            TextPattern text;
            ScrollPattern scroll;

            if (Has(element, TogglePattern.Pattern, out toggle))
            {
                ToggleState state = toggle.Cached.ToggleState;
                if (state == ToggleState.On) states.Add("checked");
                else if (state == ToggleState.Indeterminate) states.Add("mixed");
                if (enabled) can.Add("toggle");
            }
            if (Has(element, SelectionItemPattern.Pattern, out selection))
            {
                if (selection.Cached.IsSelected) states.Add(role == "radio" ? "checked" : "selected");
                if (enabled) can.Add("select");
            }
            if (Has(element, ExpandCollapsePattern.Pattern, out expand))
            {
                ExpandCollapseState state = expand.Cached.ExpandCollapseState;
                if (state == ExpandCollapseState.Expanded || state == ExpandCollapseState.PartiallyExpanded) states.Add("expanded");
                else if (state == ExpandCollapseState.Collapsed) states.Add("collapsed");
                if (enabled && state != ExpandCollapseState.LeafNode) can.Add("expand");
            }
            if (Has(element, InvokePattern.Pattern, out invoke) && enabled) can.Add("invoke");
            bool readOnly = false;
            if (Has(element, ValuePattern.Pattern, out value))
            {
                readOnly = value.Cached.IsReadOnly;
                if (readOnly) states.Add("readonly");
                else if (enabled) can.Add("set_value");
                if (!node.Password) node.Value = Clip(value.Cached.Value, 2000);
            }
            else if (Has(element, RangeValuePattern.Pattern, out range))
            {
                if (!range.Cached.IsReadOnly && enabled) can.Add("set_value");
                node.Value = range.Cached.Value.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture);
            }
            else if (node.Focused && !node.Password && Has(element, TextPattern.Pattern, out text))
            {
                // A text area that has no value to read (a multi-line box, a document): the one that has the keyboard
                // holds what is being typed, and the model can only check its typing against the text itself.
                try
                {
                    node.Value = Clip(text.DocumentRange.GetText(2001), 2000);
                }
                catch (Exception)
                {
                    node.Value = null;
                }
            }
            if (Has(element, ScrollPattern.Pattern, out scroll) && (scroll.Cached.HorizontallyScrollable || scroll.Cached.VerticallyScrollable)) can.Add("scroll");
            if (node.Password) states.Add("password");
            if (info.IsRequiredForForm) states.Add("required");
            node.States = states.ToArray();
            node.Can = can.ToArray();
            return node;
        }

        private static IList<NodeInfo> ChildrenOf(NodeInfo parent, string windowId, CacheRequest request)
        {
            List<NodeInfo> list = new List<NodeInfo>();
            AutomationElement element = (AutomationElement)parent.Native;
            TreeWalker walker = TreeWalker.ControlViewWalker;
            try
            {
                AutomationElement child = walker.GetFirstChild(element, request);
                while (child != null && list.Count < SiblingLimit)
                {
                    try
                    {
                        list.Add(Read(child, windowId));
                    }
                    catch (ElementNotAvailableException)
                    {
                    }
                    child = walker.GetNextSibling(child, request);
                }
            }
            catch (ElementNotAvailableException)
            {
            }
            return list;
        }

        // ---------------------------------------------------------------- the outline

        /// <summary>Walks the window and returns what is in view. Refs are handed out here, once an element is listed.</summary>
        public OutlineResult Outline(WindowRecord window, OutlineLimits limits, Cancel cancel)
        {
            OutlineResult result = Worker.Run<OutlineResult>(delegate()
            {
                AutomationElement rootElement = AutomationElement.FromHandle(window.Hwnd);
                NodeInfo root = new NodeInfo();
                root.Native = rootElement;
                root.Key = window.Id;
                root.Box = window.Box;
                CacheRequest request = MakeCache();
                string windowId = window.Id;
                Func<NodeInfo, IList<NodeInfo>> children = delegate(NodeInfo parent)
                {
                    if (cancel != null) cancel.Check();
                    return ChildrenOf(parent, windowId, request);
                };
                return OutlineBuilder.Build(root, children, window.Box, limits);
            }, limits.DeadlineMs + 4000, "Reading the window", cancel);
            foreach (OutlineEntry entry in result.Entries) Register(entry.Node, window.Id);
            return result;
        }

        /// <summary>The ref of an element: the same one every time the element is seen, a new one for a new element.</summary>
        public string Register(NodeInfo node, string windowId)
        {
            string key = node.Key ?? (windowId + ":" + node.Role + ":" + node.Name);
            string reference;
            if (!refOf.TryGetValue(key, out reference))
            {
                reference = "e" + (++counter).ToString(System.Globalization.CultureInfo.InvariantCulture);
                refOf[key] = reference;
                order.Enqueue(reference);
            }
            ElementEntry entry;
            if (!byRef.TryGetValue(reference, out entry))
            {
                entry = new ElementEntry();
                entry.Ref = reference;
                byRef[reference] = entry;
            }
            entry.Key = key;
            entry.Element = (AutomationElement)node.Native;
            entry.WindowId = windowId;
            entry.Role = node.Role;
            entry.Name = node.Name;
            node.Key = key;
            Trim();
            return reference;
        }

        public string RefOf(NodeInfo node)
        {
            string reference;
            return node.Key != null && refOf.TryGetValue(node.Key, out reference) ? reference : null;
        }

        private void Trim()
        {
            while (byRef.Count > TableLimit && order.Count > 0)
            {
                string oldest = order.Dequeue();
                ElementEntry entry;
                if (byRef.TryGetValue(oldest, out entry))
                {
                    byRef.Remove(oldest);
                    refOf.Remove(entry.Key);
                }
            }
        }

        public void ForgetWindow(string windowId)
        {
            List<string> drop = new List<string>();
            foreach (KeyValuePair<string, ElementEntry> pair in byRef) if (pair.Value.WindowId == windowId) drop.Add(pair.Key);
            foreach (string reference in drop)
            {
                refOf.Remove(byRef[reference].Key);
                byRef.Remove(reference);
            }
        }

        /// <summary>The element a ref names, if it was handed out for this window.</summary>
        public ElementEntry Entry(string reference, string windowId)
        {
            ElementEntry entry;
            if (reference == null || !byRef.TryGetValue(reference, out entry) || entry.WindowId != windowId)
            {
                throw new HelperException("stale-element", "Element " + reference + " is no longer in " + windowId + ".");
            }
            return entry;
        }

        // ---------------------------------------------------------------- using one element

        /// <summary>Asks the element how it is now; a stale-element error when it is gone.</summary>
        public ElementNow Now(ElementEntry entry, Cancel cancel)
        {
            return Worker.Run<ElementNow>(delegate()
            {
                ElementNow now = new ElementNow();
                AutomationElement element = entry.Element;
                AutomationElement.AutomationElementInformation info = element.Current;
                now.Box = BoxOf(info.BoundingRectangle);
                now.Enabled = info.IsEnabled;
                now.Offscreen = info.IsOffscreen;
                now.Password = info.IsPassword;
                now.CanFocus = info.IsKeyboardFocusable;
                object pattern;
                now.Invoke = element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern);
                now.Toggle = element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern);
                now.Select = element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern);
                now.Expand = element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern);
                if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
                {
                    now.Value = true;
                    now.ValueReadOnly = ((ValuePattern)pattern).Current.IsReadOnly;
                }
                if (element.TryGetCurrentPattern(RangeValuePattern.Pattern, out pattern)) now.Range = true;
                return now;
            }, 3000, "Reading " + entry.Ref, cancel);
        }

        public Box? ClickableBox(ElementEntry entry, Cancel cancel)
        {
            return Worker.Run<Box?>(delegate()
            {
                System.Windows.Point point;
                if (entry.Element.TryGetClickablePoint(out point))
                {
                    return new Box((int)Math.Round(point.X), (int)Math.Round(point.Y), 1, 1);
                }
                return null;
            }, 3000, "Finding where " + entry.Ref + " is", cancel);
        }

        public void Invoke(ElementEntry entry, string how, Cancel cancel)
        {
            Worker.Run(delegate()
            {
                object pattern;
                if (how == "invoke" && entry.Element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) ((InvokePattern)pattern).Invoke();
                else if (how == "toggle" && entry.Element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) ((TogglePattern)pattern).Toggle();
                else if (how == "select" && entry.Element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) ((SelectionItemPattern)pattern).Select();
                else if (how == "expand" && entry.Element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern))
                {
                    ExpandCollapsePattern expand = (ExpandCollapsePattern)pattern;
                    if (expand.Current.ExpandCollapseState == ExpandCollapseState.Expanded) expand.Collapse();
                    else expand.Expand();
                }
                else throw new HelperException("failed", entry.Ref + " does not support " + how + ".");
            }, 2500, "Using " + entry.Ref, cancel);
        }

        public void SetValue(ElementEntry entry, string text, Cancel cancel)
        {
            Worker.Run(delegate()
            {
                object pattern;
                if (entry.Element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
                {
                    ValuePattern value = (ValuePattern)pattern;
                    if (value.Current.IsReadOnly) throw new HelperException("failed", entry.Ref + " is read-only.");
                    value.SetValue(text);
                    return;
                }
                if (entry.Element.TryGetCurrentPattern(RangeValuePattern.Pattern, out pattern))
                {
                    double number;
                    if (!double.TryParse(text, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out number))
                    {
                        throw new HelperException("failed", entry.Ref + " takes a number.");
                    }
                    ((RangeValuePattern)pattern).SetValue(number);
                    return;
                }
                throw new HelperException("failed", entry.Ref + " cannot be set directly.");
            }, 2500, "Setting " + entry.Ref, cancel);
        }

        public void Focus(ElementEntry entry, Cancel cancel)
        {
            Worker.Run(delegate()
            {
                entry.Element.SetFocus();
            }, 2500, "Focusing " + entry.Ref, cancel);
        }

        // ---------------------------------------------------------------- the focused field

        /// <summary>Whether the field that has the keyboard focus is a password field. Fails closed: if it cannot be asked, it is an error and nothing is typed.</summary>
        public bool FocusIsPassword(Cancel cancel)
        {
            return Worker.Run<bool>(delegate()
            {
                AutomationElement focused = AutomationElement.FocusedElement;
                return focused != null && focused.Current.IsPassword;
            }, 1500, "Checking which field has the focus", cancel);
        }

        /// <summary>The boxes of password fields in a window, so that a screenshot never shows one. Best effort: a window that does not answer is taken as having none.</summary>
        public List<Box> PasswordBoxes(WindowRecord window, Cancel cancel)
        {
            try
            {
                return Worker.Run<List<Box>>(delegate()
                {
                    List<Box> boxes = new List<Box>();
                    AutomationElement root = AutomationElement.FromHandle(window.Hwnd);
                    AutomationElementCollection found = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.IsPasswordProperty, true));
                    foreach (AutomationElement element in found)
                    {
                        try
                        {
                            Box box = BoxOf(element.Current.BoundingRectangle);
                            if (!box.IsEmpty) boxes.Add(box);
                        }
                        catch (ElementNotAvailableException)
                        {
                        }
                    }
                    return boxes;
                }, 1500, "Looking for password fields", cancel);
            }
            catch (HelperException error)
            {
                if (error.Code == "hung" || error.Code == "failed" || error.Code == "stale-element") return new List<Box>();
                throw;
            }
        }
    }
}
