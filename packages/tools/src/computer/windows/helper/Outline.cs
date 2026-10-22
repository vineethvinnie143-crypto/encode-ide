using System;
using System.Collections.Generic;
using System.Diagnostics;

namespace Encode.Desktop
{
    /// <summary>One element as the accessibility interface reported it, already in the words of the contract.</summary>
    internal sealed class NodeInfo
    {
        private static readonly string[] None = new string[0];

        /// <summary>What the element is in the platform's own terms; the walker's caller uses it to act on the element later.</summary>
        public object Native;
        /// <summary>An identity that stays the same while the element lives; null when the application gave none.</summary>
        public string Key;
        /// <summary>One of ROLES in contract.ts; null for kinds the outline never lists, such as separators and scroll bars.</summary>
        public string Role;
        public string Name = "";
        /// <summary>The text of an edit, the position of a slider; null when it has none. Never a password's.</summary>
        public string Value;
        public string[] States = None;
        public string[] Can = None;
        public Box Box;
        public bool Offscreen;
        public bool Focused;
        public bool Password;
    }

    internal sealed class OutlineEntry
    {
        public NodeInfo Node;
        public int Depth;
    }

    internal sealed class OutlineLimits
    {
        /// <summary>Elements the outline keeps. More are counted, up to the other limits, so the model is told how many were cut.</summary>
        public int MaxEntries = 300;
        /// <summary>Elements looked at in all, listed or not. Each one costs a call to the application.</summary>
        public int MaxVisits = 2500;
        public int MaxDepth = 40;
        /// <summary>Children read per element: a list of thousands is read as far as this and no further.</summary>
        public int MaxChildren = 400;
        public int DeadlineMs = 3500;
    }

    internal sealed class OutlineResult
    {
        public readonly List<OutlineEntry> Entries = new List<OutlineEntry>();
        /// <summary>Where every password field in view is, listed or not, so that a screenshot can paint over them.</summary>
        public readonly List<Box> Passwords = new List<Box>();
        /// <summary>The elements in view that the walk saw, listed or not.</summary>
        public int Total;
        public int Visits;
        /// <summary>The walk stopped at a limit: the real total is higher than Total.</summary>
        public bool Cut;
    }

    /// <summary>
    /// Turns a tree of elements into the flat, indented list the model reads: what is in view, in reading
    /// order, without the containers that say nothing. It knows nothing of the platform; the caller hands
    /// it the way to read children, so the rules can be tested without a desktop.
    /// </summary>
    internal static class OutlineBuilder
    {
        /// <summary>Roles that are listed only when they have a name or something to do: a pane with neither adds a level and no meaning.</summary>
        private static readonly HashSet<string> NamedOnly = new HashSet<string>
        {
            "window", "pane", "group", "text", "image", "header", "row", "cell", "titlebar", "tooltip"
        };

        public static OutlineResult Build(NodeInfo root, Func<NodeInfo, IList<NodeInfo>> children, Box window, OutlineLimits limits)
        {
            OutlineResult result = new OutlineResult();
            Stopwatch clock = Stopwatch.StartNew();
            if (root.Key == null) root.Key = "root";
            Walk(root, children, window, limits, clock, result, 0, 0);
            if (result.Cut && result.Total <= result.Entries.Count) result.Total = result.Entries.Count + 1;
            return result;
        }

        private static bool Spent(OutlineLimits limits, Stopwatch clock, OutlineResult result)
        {
            return result.Visits >= limits.MaxVisits || clock.ElapsedMilliseconds >= limits.DeadlineMs;
        }

        private static void Walk(NodeInfo parent, Func<NodeInfo, IList<NodeInfo>> children, Box window, OutlineLimits limits, Stopwatch clock, OutlineResult result, int depth, int shown)
        {
            IList<NodeInfo> kids = children(parent);
            Dictionary<string, int> seen = new Dictionary<string, int>();
            int index = 0;
            foreach (NodeInfo kid in kids)
            {
                if (Spent(limits, clock, result)) { result.Cut = true; return; }
                if (index++ >= limits.MaxChildren) { result.Cut = true; break; }
                result.Visits++;
                if (kid.Key == null)
                {
                    string label = (kid.Role ?? "?") + ":" + kid.Name;
                    int ordinal;
                    seen.TryGetValue(label, out ordinal);
                    seen[label] = ordinal + 1;
                    kid.Key = parent.Key + "/" + label + "#" + ordinal;
                }
                if (kid.Offscreen || kid.Role == null) continue;
                if (kid.Password && !kid.Box.IsEmpty) result.Passwords.Add(kid.Box);
                bool listed = Wanted(kid, window);
                int below = shown;
                if (listed)
                {
                    result.Total++;
                    if (result.Entries.Count < limits.MaxEntries) result.Entries.Add(new OutlineEntry { Node = kid, Depth = shown });
                    below = shown + 1;
                }
                if (depth + 1 <= limits.MaxDepth) Walk(kid, children, window, limits, clock, result, depth + 1, below);
                else result.Cut = true;
                if (result.Cut && Spent(limits, clock, result)) return;
            }
        }

        private static bool Wanted(NodeInfo node, Box window)
        {
            if (node.Box.IsEmpty || !node.Box.Intersects(window)) return false;
            if (node.Name.Length == 0 && node.Can.Length == 0 && NamedOnly.Contains(node.Role)) return false;
            return true;
        }
    }
}
