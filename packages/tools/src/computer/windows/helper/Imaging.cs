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

        /// <summary>The picture's brightness, pixel by pixel; with `step` 2, every second pixel in each direction: four times faster, for the polling that waits for a window to settle.</summary>
        public static Frame Sample(Bitmap bitmap, int step)
        {
            int width = bitmap.Width;
            int height = bitmap.Height;
            Frame frame = new Frame((width + step - 1) / step, (height + step - 1) / step, step);
            BitmapData data = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
            try
            {
                byte[] row = new byte[width * 3];
                int at = 0;
                for (int y = 0; y < height; y += step)
                {
                    Marshal.Copy(new IntPtr(data.Scan0.ToInt64() + (long)y * data.Stride), row, 0, row.Length);
                    for (int x = 0; x < width; x += step)
                    {
                        int i = x * 3;
                        frame.Luma[at++] = (byte)((row[i + 2] * 299 + row[i + 1] * 587 + row[i] * 114) / 1000);
                    }
                }
            }
            finally
            {
                bitmap.UnlockBits(data);
            }
            return frame;
        }

        /// <summary>The picture at another size, or the picture itself when it is that size already: the caller disposes a new one.</summary>
        public static Bitmap Resize(Bitmap source, int width, int height)
        {
            if (width == source.Width && height == source.Height) return source;
            Bitmap scaled = new Bitmap(width, height, PixelFormat.Format24bppRgb);
            try
            {
                using (Graphics graphics = Graphics.FromImage(scaled))
                {
                    graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    graphics.SmoothingMode = SmoothingMode.HighQuality;
                    graphics.CompositingQuality = CompositingQuality.HighQuality;
                    using (ImageAttributes edges = new ImageAttributes())
                    {
                        // Without it the border pixels blend with nothing, and a picture enlarged by a zoom gets a faint frame.
                        edges.SetWrapMode(WrapMode.TileFlipXY);
                        graphics.DrawImage(source, new Rectangle(0, 0, width, height), 0, 0, source.Width, source.Height, GraphicsUnit.Pixel, edges);
                    }
                }
                return scaled;
            }
            catch (Exception)
            {
                scaled.Dispose();
                throw;
            }
        }

        /// <summary>The picture at the size it is sent, as base64: PNG, or JPEG when the window is a photograph and PNG would be huge.</summary>
        public static string Encode(Bitmap source, int width, int height, out string mediaType)
        {
            Bitmap use = Resize(source, width, height);
            try
            {
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
                if (!ReferenceEquals(use, source)) use.Dispose();
            }
        }

        // ---------------------------------------------------------------- marks and grids (ADR 0121)

        /// <summary>Dark enough for white digits, and far enough apart that two neighbours are told apart.</summary>
        private static readonly Color[] MarkColors =
        {
            Color.FromArgb(0xD7, 0x26, 0x3D), Color.FromArgb(0x0F, 0x76, 0x6E), Color.FromArgb(0x25, 0x63, 0xEB), Color.FromArgb(0xC2, 0x41, 0x0C),
            Color.FromArgb(0x7E, 0x22, 0xCE), Color.FromArgb(0x15, 0x80, 0x3D), Color.FromArgb(0xBE, 0x18, 0x5D), Color.FromArgb(0x0E, 0x74, 0x90)
        };

        /// <summary>The size of a digit in the font the numbers are drawn with, and the height of a number's tag, in image pixels.</summary>
        public const int MarkCharWidth = 7;
        public const int MarkTagHeight = 14;

        private static Font LabelFont()
        {
            // GDI+ puts another sans-serif face in when Segoe UI is missing, as on a server without the desktop fonts.
            return new Font("Segoe UI", 11f, FontStyle.Bold, GraphicsUnit.Pixel);
        }

        /// <summary>Draws each mark: a frame around the element when it is not too big to frame, and its number on a tag.</summary>
        public static void DrawMarks(Bitmap image, IList<PlacedMark> marks)
        {
            if (marks.Count == 0) return;
            using (Graphics graphics = Graphics.FromImage(image))
            using (Font font = LabelFont())
            using (StringFormat format = new StringFormat(StringFormatFlags.NoWrap | StringFormatFlags.NoClip))
            {
                graphics.SmoothingMode = SmoothingMode.None;
                graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                format.Alignment = StringAlignment.Center;
                format.LineAlignment = StringAlignment.Center;
                // Frames first, so that no frame runs across a number.
                foreach (PlacedMark mark in marks)
                {
                    if (!mark.Border) continue;
                    using (Pen pen = new Pen(Color.FromArgb(225, MarkColors[mark.Color % MarkColors.Length]), 2))
                    {
                        graphics.DrawRectangle(pen, mark.Box.X + 1, mark.Box.Y + 1, Math.Max(1, mark.Box.W - 2), Math.Max(1, mark.Box.H - 2));
                    }
                }
                foreach (PlacedMark mark in marks)
                {
                    using (SolidBrush fill = new SolidBrush(MarkColors[mark.Color % MarkColors.Length]))
                    {
                        graphics.FillRectangle(fill, mark.Tag.X, mark.Tag.Y, mark.Tag.W, mark.Tag.H);
                    }
                    graphics.DrawString(mark.Label, font, Brushes.White, new RectangleF(mark.Tag.X, mark.Tag.Y, mark.Tag.W, mark.Tag.H), format);
                }
            }
        }

        /// <summary>Draws lines across the picture at the columns and rows given, each with its number at the top or the left edge.</summary>
        public static void DrawGrid(Bitmap image, IList<GridLine> columns, IList<GridLine> rows)
        {
            if (columns.Count == 0 && rows.Count == 0) return;
            using (Graphics graphics = Graphics.FromImage(image))
            using (Pen pen = new Pen(Color.FromArgb(150, 0xFF, 0x00, 0xAA), 1))
            using (Font font = LabelFont())
            using (SolidBrush back = new SolidBrush(Color.FromArgb(215, 0x18, 0x18, 0x1B)))
            {
                graphics.SmoothingMode = SmoothingMode.None;
                graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                foreach (GridLine line in columns) graphics.DrawLine(pen, line.At, 0, line.At, image.Height - 1);
                foreach (GridLine line in rows) graphics.DrawLine(pen, 0, line.At, image.Width - 1, line.At);
                foreach (GridLine line in columns) Tag(graphics, font, back, line.Label, line.At + 2, 1, image);
                foreach (GridLine line in rows) Tag(graphics, font, back, line.Label, 1, line.At + 2, image);
            }
        }

        private static void Tag(Graphics graphics, Font font, Brush back, string text, int x, int y, Bitmap image)
        {
            SizeF size = graphics.MeasureString(text, font);
            int width = (int)Math.Ceiling(size.Width) + 2;
            int height = (int)Math.Ceiling(size.Height);
            int left = Math.Max(0, Math.Min(image.Width - width, x));
            int top = Math.Max(0, Math.Min(image.Height - height, y));
            graphics.FillRectangle(back, left, top, width, height);
            graphics.DrawString(text, font, Brushes.White, left + 1, top);
        }
    }

    /// <summary>A line of a grid, in image pixels, and the number it is labelled with.</summary>
    internal struct GridLine
    {
        public int At;
        public string Label;

        public GridLine(int at, string label)
        {
            At = at;
            Label = label;
        }
    }
}
