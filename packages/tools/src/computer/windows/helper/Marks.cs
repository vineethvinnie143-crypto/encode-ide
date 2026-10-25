using System;
using System.Collections.Generic;

namespace Encode.Desktop
{
    /// <summary>An element that may carry its number on a screenshot: the number of its ref, its role, its box in image pixels, and whether it does anything.</summary>
    internal sealed class MarkCandidate
    {
        public string Label;
        public string Role;
        public Box Box;
        public bool Acts;
    }

    /// <summary>A number drawn on a screenshot, in image pixels: the element's box, whether its border is drawn, where the number goes and in which colour.</summary>
    internal sealed class PlacedMark
    {
        public string Label;
        public Box Box;
        public bool Border;
        public Box Tag;
        public int Color;
    }

    /// <summary>
    /// Which elements of an outline carry their number on the screenshot, and where each number goes (ADR 0121). The model reads
    /// "12" on a button and acts on e12, instead of estimating where the button is. Only what a person would click gets a number:
    /// containers would cover the picture with frames that say nothing. A number sits just above its element's top-left corner,
    /// or at the next place that does not hide another number.
    /// </summary>
    internal static class MarkPlan
    {
        public const int MaxMarks = 150;
        public const int Colors = 8;
        private const int MinSide = 4;

        private static readonly HashSet<string> Controls = new HashSet<string>
        {
            "button", "checkbox", "radio", "combobox", "edit", "document", "link", "listitem", "menuitem", "tabitem", "treeitem",
            "cell", "row", "header", "slider", "spinner", "image"
        };

        /// <summary>Text areas may fill most of a window and still be what the model types into.</summary>
        private static readonly HashSet<string> Areas = new HashSet<string> { "edit", "document" };

        /// <summary>The part of the box inside the picture.</summary>
        public static Box Clip(Box box, int width, int height)
        {
            return box.Intersect(new Box(0, 0, width, height));
        }

        public static bool Markable(MarkCandidate candidate, int width, int height)
        {
            if (candidate == null || string.IsNullOrEmpty(candidate.Label)) return false;
            Box box = Clip(candidate.Box, width, height);
            if (box.W < MinSide || box.H < MinSide) return false;
            if (!candidate.Acts && (candidate.Role == null || !Controls.Contains(candidate.Role))) return false;
            long area = (long)box.W * box.H;
            long whole = (long)width * height;
            return area * 2 <= whole || (candidate.Role != null && Areas.Contains(candidate.Role));
        }

        /// <summary>
        /// The marks for these candidates, in outline order, at most `max`: the ones that act come first when there are more.
        /// `charWidth` and `tagHeight` are the size of the number's characters in the font it is drawn with.
        /// </summary>
        public static List<PlacedMark> Place(IList<MarkCandidate> candidates, int width, int height, int charWidth, int tagHeight, int max)
        {
            List<int> chosen = new List<int>();
            for (int i = 0; i < candidates.Count; i++) if (Markable(candidates[i], width, height)) chosen.Add(i);
            if (chosen.Count > max)
            {
                List<int> acting = new List<int>();
                List<int> rest = new List<int>();
                foreach (int i in chosen) (candidates[i].Acts ? acting : rest).Add(i);
                List<int> kept = new List<int>();
                foreach (int i in acting) if (kept.Count < max) kept.Add(i);
                foreach (int i in rest) if (kept.Count < max) kept.Add(i);
                kept.Sort();
                chosen = kept;
            }

            List<PlacedMark> placed = new List<PlacedMark>();
            List<Box> tags = new List<Box>();
            long whole = (long)width * height;
            foreach (int i in chosen)
            {
                MarkCandidate candidate = candidates[i];
                Box box = Clip(candidate.Box, width, height);
                int tagW = Math.Min(width, 4 + charWidth * candidate.Label.Length);
                int tagH = Math.Min(height, tagHeight);
                Box tag = Spot(box, tagW, tagH, width, height, tags);
                PlacedMark mark = new PlacedMark();
                mark.Label = candidate.Label;
                mark.Box = box;
                mark.Border = (long)box.W * box.H * 4 <= whole;
                mark.Tag = tag;
                mark.Color = placed.Count % Colors;
                placed.Add(mark);
                tags.Add(tag);
            }
            return placed;
        }

        /// <summary>Above the top-left corner, inside it, to its left, below it, inside the top-right corner: the first that hides no other number.</summary>
        private static Box Spot(Box box, int tagW, int tagH, int width, int height, List<Box> taken)
        {
            int[][] tries = new int[][]
            {
                new int[] { box.X, box.Y - tagH },
                new int[] { box.X, box.Y },
                new int[] { box.X - tagW, box.Y },
                new int[] { box.X, box.Bottom },
                new int[] { box.Right - tagW, box.Y },
            };
            Box first = Box.Empty;
            for (int n = 0; n < tries.Length; n++)
            {
                Box tag = new Box(Math.Max(0, Math.Min(width - tagW, tries[n][0])), Math.Max(0, Math.Min(height - tagH, tries[n][1])), tagW, tagH);
                if (n == 1) first = tag;
                bool free = true;
                foreach (Box other in taken)
                {
                    if (other.Intersects(tag))
                    {
                        free = false;
                        break;
                    }
                }
                if (free) return tag;
            }
            return first;
        }
    }

    /// <summary>
    /// The lines of a grid labelled in pixels (ADR 0121): on a zoom, in the pixels of the screenshot it enlarges, so the model reads
    /// a coordinate off the picture instead of working it out; on a screenshot of a window that lists nothing, in its own pixels.
    /// </summary>
    internal static class GridPlan
    {
        private static readonly int[] Steps = { 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000 };

        /// <summary>
        /// The spacing of the lines, in the units the labels count: the smallest that leaves `minGap` image pixels between two lines
        /// and puts at most `maxLines` across `span` units. `pixelsPerUnit` is how many image pixels one unit takes.
        /// </summary>
        public static int Step(double span, double pixelsPerUnit, int minGap, int maxLines)
        {
            if (!(span > 0) || !(pixelsPerUnit > 0)) return Steps[Steps.Length - 1];
            foreach (int step in Steps)
            {
                if (step * pixelsPerUnit >= minGap && span / step <= maxLines) return step;
            }
            return Steps[Steps.Length - 1];
        }

        /// <summary>The multiples of `step` strictly between `from` and `to`.</summary>
        public static List<int> Lines(double from, double to, int step)
        {
            List<int> lines = new List<int>();
            if (step <= 0 || !(to > from)) return lines;
            long first = (long)Math.Floor(from / step) + 1;
            for (long n = first; n * step < to && lines.Count < 200; n++) lines.Add((int)(n * step));
            return lines;
        }
    }
}
