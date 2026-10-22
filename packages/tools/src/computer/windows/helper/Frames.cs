using System;

namespace Encode.Desktop
{
    /// <summary>A picture's brightness, pixel by pixel or every `Step`th pixel, kept to tell whether the next picture of the window differs.</summary>
    internal sealed class Frame
    {
        public readonly int Width;
        public readonly int Height;
        public readonly int Step;
        public readonly byte[] Luma;

        public Frame(int width, int height, int step)
        {
            Width = width;
            Height = height;
            Step = step;
            Luma = new byte[width * height];
        }
    }

    /// <summary>The rule for "the window changed", kept free of any drawing code so that it is tested on its own.</summary>
    internal static class Frames
    {
        // Brightness levels a pixel must move to count: anti-aliasing and compression noise stay below it.
        public const int Tolerance = 20;
        // A blinking text caret is one thin bar about as tall as a line of text, at 100% to 300% scale.
        public const int CaretMaxWidth = 4;
        public const int CaretMinHeight = 8;
        public const int CaretMaxHeight = 56;

        /// <summary>
        /// Whether two pictures of one window differ the way a person would call a change. One thin bar as tall as a line of
        /// text is a caret blinking, which is not; anything else is, however small. (A letter as thin as a caret, typed
        /// while the caret is hidden in both pictures, goes unseen: the outline and a new look still show it.)
        /// </summary>
        public static bool Differs(Frame a, Frame b)
        {
            if (a == null || b == null || a.Width != b.Width || a.Height != b.Height || a.Step != b.Step) return true;
            int step = a.Step;
            int count = 0;
            int minX = int.MaxValue;
            int maxX = -1;
            int minY = int.MaxValue;
            int maxY = -1;
            for (int y = 0; y < a.Height; y++)
            {
                int row = y * a.Width;
                for (int x = 0; x < a.Width; x++)
                {
                    int difference = a.Luma[row + x] - b.Luma[row + x];
                    if (difference < Tolerance && difference > -Tolerance) continue;
                    count++;
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                    if ((maxX - minX + 1) * step > CaretMaxWidth || (maxY - minY + 1) * step > CaretMaxHeight) return true;
                }
            }
            if (count == 0) return false;
            int width = (maxX - minX + 1) * step;
            int height = (maxY - minY + 1) * step;
            bool caret = height >= CaretMinHeight && count * step * step * 2 >= width * height;
            return !caret;
        }
    }
}
