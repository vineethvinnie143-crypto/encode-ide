using System;

namespace Encode.Desktop
{
    /// <summary>A rectangle in screen pixels. Mirrors Box in contract.ts: left, top, width, height.</summary>
    internal struct Box
    {
        public int X;
        public int Y;
        public int W;
        public int H;

        public Box(int x, int y, int w, int h)
        {
            X = x;
            Y = y;
            W = w;
            H = h;
        }

        public static readonly Box Empty = new Box(0, 0, 0, 0);

        public int Right { get { return X + W; } }
        public int Bottom { get { return Y + H; } }
        public bool IsEmpty { get { return W <= 0 || H <= 0; } }
        public int CenterX { get { return X + W / 2; } }
        public int CenterY { get { return Y + H / 2; } }

        public bool Contains(int px, int py)
        {
            return px >= X && px < X + W && py >= Y && py < Y + H;
        }

        public bool Intersects(Box other)
        {
            return !IsEmpty && !other.IsEmpty && X < other.Right && other.X < Right && Y < other.Bottom && other.Y < Bottom;
        }

        public Box Intersect(Box other)
        {
            int left = Math.Max(X, other.X);
            int top = Math.Max(Y, other.Y);
            int right = Math.Min(Right, other.Right);
            int bottom = Math.Min(Bottom, other.Bottom);
            return right > left && bottom > top ? new Box(left, top, right - left, bottom - top) : Empty;
        }

        public bool Same(Box other)
        {
            return X == other.X && Y == other.Y && W == other.W && H == other.H;
        }

        public object[] ToJson()
        {
            return new object[] { X, Y, W, H };
        }

        public static Box FromJson(object value)
        {
            int[] numbers = Args.Ints(value, 4);
            return numbers == null ? Empty : new Box(numbers[0], numbers[1], numbers[2], numbers[3]);
        }

        public override string ToString()
        {
            return "[" + X + ", " + Y + ", " + W + ", " + H + "]";
        }
    }

    /// <summary>The arithmetic between what the model sees and what the screen is. Mirrors geometry.ts exactly.</summary>
    internal static class Geo
    {
        public const int MaxImageEdge = 1568;
        public const int MaxImagePixels = 1150000;

        /// <summary>Math.round in JavaScript: halves round up, also below zero.</summary>
        public static int Round(double value)
        {
            return (int)Math.Floor(value + 0.5);
        }

        /// <summary>The size an image of width x height screen pixels is sent at: never larger than the screen, and within the budget.</summary>
        public static void FitImage(int width, int height, int maxEdge, int maxPixels, out int outWidth, out int outHeight, out double scale)
        {
            if (width <= 0 || height <= 0)
            {
                outWidth = 0;
                outHeight = 0;
                scale = 1;
                return;
            }
            double byEdge = (double)maxEdge / Math.Max(width, height);
            double byArea = Math.Sqrt((double)maxPixels / ((double)width * height));
            double s = Math.Min(1.0, Math.Min(byEdge, byArea));
            if (s >= 1.0)
            {
                outWidth = width;
                outHeight = height;
                scale = 1;
                return;
            }
            outWidth = Math.Max(1, Round(width * s));
            outHeight = Math.Max(1, Round(height * s));
            scale = s;
        }

        /// <summary>The largest a zoom enlarges what it shows (ADR 0121).</summary>
        public const double MaxZoom = 4;

        /// <summary>
        /// The size a zoom of width x height screen pixels is sent at: as large as the budget allows, up to MaxZoom times the screen,
        /// so a small area is shown big enough to point into; smaller than the screen only when it is too big to send whole.
        /// </summary>
        public static void FitZoom(int width, int height, int maxEdge, int maxPixels, out int outWidth, out int outHeight, out double scale)
        {
            if (width <= 0 || height <= 0)
            {
                outWidth = 0;
                outHeight = 0;
                scale = 1;
                return;
            }
            double byEdge = (double)maxEdge / Math.Max(width, height);
            double byArea = Math.Sqrt((double)maxPixels / ((double)width * height));
            double s = Math.Min(MaxZoom, Math.Min(byEdge, byArea));
            outWidth = Math.Max(1, Round(width * s));
            outHeight = Math.Max(1, Round(height * s));
            scale = s;
        }

        /// <summary>Where a point of the capture's image is on the screen.</summary>
        public static void ToScreen(int px, int py, Box captureBox, double scale, out int x, out int y)
        {
            x = captureBox.X + Round(px / scale);
            y = captureBox.Y + Round(py / scale);
        }

        /// <summary>A screen box in the capture's image, clipped to the image. Mirrors boxToImage in geometry.ts.</summary>
        public static Box BoxToImage(Box box, Box captureBox, double scale, int width, int height)
        {
            int left = Math.Max(0, Round((box.X - captureBox.X) * scale));
            int top = Math.Max(0, Round((box.Y - captureBox.Y) * scale));
            int right = Math.Min(width, Round((box.X + box.W - captureBox.X) * scale));
            int bottom = Math.Min(height, Round((box.Y + box.H - captureBox.Y) * scale));
            return new Box(left, top, Math.Max(0, right - left), Math.Max(0, bottom - top));
        }
    }
}
