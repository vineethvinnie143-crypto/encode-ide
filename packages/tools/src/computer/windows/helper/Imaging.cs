using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

namespace Encode.Desktop
{
    /// <summary>Screenshots: taking them, painting over what the model must not see, shrinking them, and telling whether two are the same picture.</summary>
    internal static class Imaging
    {
        public const int Columns = 64;
        public const int Rows = 40;
        private const int PngLimit = 900000;
        private static readonly Color MaskColor = Color.FromArgb(0x6E, 0x6E, 0x76);

        /// <summary>What is on the screen in the box now, windows in front of it included. Painting over those is the caller's job.</summary>
        public static Bitmap Grab(Box box)
        {
            if (box.IsEmpty) throw new HelperException("failed", "There is nothing to take a picture of: the area has no size.");
            Bitmap bitmap = new Bitmap(box.W, box.H, PixelFormat.Format24bppRgb);
            try
            {
                // Graphics.CopyFromScreen rejects the two flags together, and layered windows are left out without CAPTUREBLT.
                IntPtr screen = Native.GetDC(IntPtr.Zero);
                if (screen == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                try
                {
                    using (Graphics graphics = Graphics.FromImage(bitmap))
                    {
                        IntPtr target = graphics.GetHdc();
                        try
                        {
                            if (!Native.BitBlt(target, 0, 0, box.W, box.H, screen, box.X, box.Y, Const.SRCCOPY | Const.CAPTUREBLT)) throw new Win32Exception(Marshal.GetLastWin32Error());
                        }
                        finally
                        {
                            graphics.ReleaseHdc(target);
                        }
                    }
                }
                finally
                {
                    Native.ReleaseDC(IntPtr.Zero, screen);
                }
                return bitmap;
            }
            catch (Win32Exception error)
            {
                bitmap.Dispose();
                throw new HelperException("unavailable", "The screen cannot be read now (it may be locked): " + error.Message);
            }
            catch (Exception)
            {
                bitmap.Dispose();
                throw;
            }
        }

        public static void Paint(Bitmap bitmap, Box origin, IList<Box> masks)
        {
            if (masks.Count == 0) return;
            using (Graphics graphics = Graphics.FromImage(bitmap))
            using (SolidBrush brush = new SolidBrush(MaskColor))
            {
                foreach (Box mask in masks) graphics.FillRectangle(brush, mask.X - origin.X, mask.Y - origin.Y, mask.W, mask.H);
            }
        }

        /// <summary>The picture as a grid of 64 x 40 average brightnesses: small enough to compare often, fine enough to see a line of text change.</summary>
        public static byte[] Thumb(Bitmap bitmap)
        {
            return Thumb(bitmap, 1);
        }

        /// <summary>With `step` 2, every second pixel in each direction: four times faster, for the polling that waits for a window to settle.</summary>
        public static byte[] Thumb(Bitmap bitmap, int step)
        {
            int width = bitmap.Width;
            int height = bitmap.Height;
            long[] sums = new long[Columns * Rows];
            int[] counts = new int[Columns * Rows];
            int[] column = new int[width];
            for (int x = 0; x < width; x++) column[x] = (int)((long)x * Columns / width);
            BitmapData data = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
            try
            {
                byte[] row = new byte[width * 3];
                for (int y = 0; y < height; y += step)
                {
                    Marshal.Copy(new IntPtr(data.Scan0.ToInt64() + (long)y * data.Stride), row, 0, row.Length);
                    int baseCell = (int)((long)y * Rows / height) * Columns;
                    for (int x = 0; x < width; x += step)
                    {
                        int i = x * 3;
                        int luma = (row[i + 2] * 299 + row[i + 1] * 587 + row[i] * 114) / 1000;
                        int cell = baseCell + column[x];
                        sums[cell] += luma;
                        counts[cell]++;
                    }
                }
            }
            finally
            {
                bitmap.UnlockBits(data);
            }
            byte[] result = new byte[Columns * Rows];
            for (int cell = 0; cell < result.Length; cell++) result[cell] = counts[cell] == 0 ? (byte)0 : (byte)(sums[cell] / counts[cell]);
            return result;
        }

        /// <summary>How many cells of the grid differ by at least `threshold` brightness levels.</summary>
        public static int ChangedCells(byte[] a, byte[] b, int threshold)
        {
            if (a == null || b == null || a.Length != b.Length) return int.MaxValue;
            int changed = 0;
            for (int i = 0; i < a.Length; i++) if (Math.Abs(a[i] - b[i]) >= threshold) changed++;
            return changed;
        }

        /// <summary>The picture at the size it is sent, as base64: PNG, or JPEG when the window is a photograph and PNG would be huge.</summary>
        public static string Encode(Bitmap source, int width, int height, out string mediaType)
        {
            Bitmap scaled = null;
            Bitmap use = source;
            try
            {
                if (width != source.Width || height != source.Height)
                {
                    scaled = new Bitmap(width, height, PixelFormat.Format24bppRgb);
                    using (Graphics graphics = Graphics.FromImage(scaled))
                    {
                        graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                        graphics.SmoothingMode = SmoothingMode.HighQuality;
                        graphics.CompositingQuality = CompositingQuality.HighQuality;
                        graphics.DrawImage(source, new Rectangle(0, 0, width, height), 0, 0, source.Width, source.Height, GraphicsUnit.Pixel);
                    }
                    use = scaled;
                }
                using (MemoryStream stream = new MemoryStream())
                {
                    use.Save(stream, ImageFormat.Png);
                    if (stream.Length <= PngLimit)
                    {
                        mediaType = "image/png";
                        return Convert.ToBase64String(stream.GetBuffer(), 0, (int)stream.Length);
                    }
                    stream.SetLength(0);
                    ImageCodecInfo jpeg = null;
                    foreach (ImageCodecInfo codec in ImageCodecInfo.GetImageEncoders()) if (codec.FormatID == ImageFormat.Jpeg.Guid) jpeg = codec;
                    if (jpeg == null)
                    {
                        use.Save(stream, ImageFormat.Png);
                        mediaType = "image/png";
                        return Convert.ToBase64String(stream.GetBuffer(), 0, (int)stream.Length);
                    }
                    using (EncoderParameters parameters = new EncoderParameters(1))
                    {
                        parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 85L);
                        use.Save(stream, jpeg, parameters);
                    }
                    mediaType = "image/jpeg";
                    return Convert.ToBase64String(stream.GetBuffer(), 0, (int)stream.Length);
                }
            }
            finally
            {
                if (scaled != null) scaled.Dispose();
            }
        }
    }
}
