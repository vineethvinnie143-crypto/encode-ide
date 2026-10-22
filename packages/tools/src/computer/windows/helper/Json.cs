using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Encode.Desktop
{
    /// <summary>
    /// The JSON the protocol speaks. A value is null, bool, long, double, string, List&lt;object&gt; or
    /// Dictionary&lt;string, object&gt;. It is small on purpose: the helper starts for the first call of a
    /// session, and nothing here uses reflection.
    /// </summary>
    internal static class Json
    {
        private const int MaxDepth = 64;

        public static object Parse(string text)
        {
            Reader reader = new Reader(text);
            reader.SkipSpace();
            object value = reader.ReadValue(0);
            reader.SkipSpace();
            if (!reader.AtEnd) throw reader.Fail("unexpected text after the value");
            return value;
        }

        public static string Write(object value)
        {
            StringBuilder sb = new StringBuilder(256);
            Write(sb, value, 0);
            return sb.ToString();
        }

        public static void Write(StringBuilder sb, object value)
        {
            Write(sb, value, 0);
        }

        private static void Write(StringBuilder sb, object value, int depth)
        {
            if (depth > MaxDepth) throw new InvalidOperationException("value nested too deeply");
            if (value == null) { sb.Append("null"); return; }
            string text = value as string;
            if (text != null) { WriteString(sb, text); return; }
            if (value is bool) { sb.Append((bool)value ? "true" : "false"); return; }
            if (value is int) { sb.Append(((int)value).ToString(CultureInfo.InvariantCulture)); return; }
            if (value is long) { sb.Append(((long)value).ToString(CultureInfo.InvariantCulture)); return; }
            if (value is uint) { sb.Append(((uint)value).ToString(CultureInfo.InvariantCulture)); return; }
            if (value is double) { WriteDouble(sb, (double)value); return; }
            if (value is float) { WriteDouble(sb, (double)(float)value); return; }
            IDictionary<string, object> map = value as IDictionary<string, object>;
            if (map != null)
            {
                sb.Append('{');
                bool first = true;
                foreach (KeyValuePair<string, object> pair in map)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteString(sb, pair.Key);
                    sb.Append(':');
                    Write(sb, pair.Value, depth + 1);
                }
                sb.Append('}');
                return;
            }
            IEnumerable list = value as IEnumerable;
            if (list != null)
            {
                sb.Append('[');
                bool first = true;
                foreach (object item in list)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    Write(sb, item, depth + 1);
                }
                sb.Append(']');
                return;
            }
            throw new InvalidOperationException("cannot write " + value.GetType().Name);
        }

        private static void WriteDouble(StringBuilder sb, double number)
        {
            if (double.IsNaN(number) || double.IsInfinity(number)) { sb.Append("null"); return; }
            if (Math.Abs(number) < 1e15 && Math.Floor(number) == number)
            {
                sb.Append(((long)number).ToString(CultureInfo.InvariantCulture));
                return;
            }
            sb.Append(number.ToString("R", CultureInfo.InvariantCulture));
        }

        private static void WriteString(StringBuilder sb, string text)
        {
            sb.Append('"');
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < 0x20 || c == (char)0x2028 || c == (char)0x2029) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        private sealed class Reader
        {
            private readonly string s;
            private int i;

            public Reader(string text)
            {
                s = text ?? "";
            }

            public bool AtEnd { get { return i >= s.Length; } }

            public Exception Fail(string what)
            {
                return new FormatException("Bad JSON at " + i.ToString(CultureInfo.InvariantCulture) + ": " + what);
            }

            public void SkipSpace()
            {
                while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++;
            }

            public object ReadValue(int depth)
            {
                if (depth > MaxDepth) throw Fail("nested too deeply");
                if (AtEnd) throw Fail("unexpected end");
                char c = s[i];
                if (c == '{') return ReadObject(depth);
                if (c == '[') return ReadArray(depth);
                if (c == '"') return ReadString();
                if (c == 't') { Expect("true"); return true; }
                if (c == 'f') { Expect("false"); return false; }
                if (c == 'n') { Expect("null"); return null; }
                if (c == '-' || (c >= '0' && c <= '9')) return ReadNumber();
                throw Fail("unexpected character '" + c + "'");
            }

            private void Expect(string word)
            {
                if (string.CompareOrdinal(s, i, word, 0, word.Length) != 0) throw Fail("expected " + word);
                i += word.Length;
            }

            private Dictionary<string, object> ReadObject(int depth)
            {
                Dictionary<string, object> map = new Dictionary<string, object>();
                i++;
                SkipSpace();
                if (!AtEnd && s[i] == '}') { i++; return map; }
                while (true)
                {
                    SkipSpace();
                    if (AtEnd || s[i] != '"') throw Fail("expected a key");
                    string key = ReadString();
                    SkipSpace();
                    if (AtEnd || s[i] != ':') throw Fail("expected ':'");
                    i++;
                    SkipSpace();
                    map[key] = ReadValue(depth + 1);
                    SkipSpace();
                    if (AtEnd) throw Fail("unexpected end");
                    if (s[i] == ',') { i++; continue; }
                    if (s[i] == '}') { i++; return map; }
                    throw Fail("expected ',' or '}'");
                }
            }

            private List<object> ReadArray(int depth)
            {
                List<object> list = new List<object>();
                i++;
                SkipSpace();
                if (!AtEnd && s[i] == ']') { i++; return list; }
                while (true)
                {
                    SkipSpace();
                    list.Add(ReadValue(depth + 1));
                    SkipSpace();
                    if (AtEnd) throw Fail("unexpected end");
                    if (s[i] == ',') { i++; continue; }
                    if (s[i] == ']') { i++; return list; }
                    throw Fail("expected ',' or ']'");
                }
            }

            private string ReadString()
            {
                StringBuilder sb = new StringBuilder();
                i++;
                while (true)
                {
                    if (AtEnd) throw Fail("unterminated string");
                    char c = s[i++];
                    if (c == '"') return sb.ToString();
                    if (c != '\\') { sb.Append(c); continue; }
                    if (AtEnd) throw Fail("unterminated escape");
                    char e = s[i++];
                    switch (e)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            if (i + 4 > s.Length) throw Fail("short \\u escape");
                            int code;
                            if (!int.TryParse(s.Substring(i, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out code)) throw Fail("bad \\u escape");
                            sb.Append((char)code);
                            i += 4;
                            break;
                        default: throw Fail("bad escape");
                    }
                }
            }

            private object ReadNumber()
            {
                int start = i;
                if (s[i] == '-') i++;
                while (i < s.Length && s[i] >= '0' && s[i] <= '9') i++;
                bool real = false;
                if (i < s.Length && s[i] == '.')
                {
                    real = true;
                    i++;
                    while (i < s.Length && s[i] >= '0' && s[i] <= '9') i++;
                }
                if (i < s.Length && (s[i] == 'e' || s[i] == 'E'))
                {
                    real = true;
                    i++;
                    if (i < s.Length && (s[i] == '+' || s[i] == '-')) i++;
                    while (i < s.Length && s[i] >= '0' && s[i] <= '9') i++;
                }
                string text = s.Substring(start, i - start);
                if (!real)
                {
                    long whole;
                    if (long.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out whole)) return whole;
                }
                double number;
                if (!double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out number)) throw Fail("bad number");
                return number;
            }
        }
    }

    /// <summary>Reads typed values out of a request without throwing on a missing key.</summary>
    internal static class Args
    {
        public static Dictionary<string, object> Obj(object value)
        {
            return value as Dictionary<string, object>;
        }

        public static object Get(Dictionary<string, object> map, string key)
        {
            object value;
            return map != null && map.TryGetValue(key, out value) ? value : null;
        }

        public static string Str(Dictionary<string, object> map, string key, string fallback)
        {
            string value = Get(map, key) as string;
            return value ?? fallback;
        }

        public static int Int(Dictionary<string, object> map, string key, int fallback)
        {
            object value = Get(map, key);
            if (value is long) return (int)Math.Max(int.MinValue, Math.Min(int.MaxValue, (long)value));
            if (value is double) return (int)Math.Max(int.MinValue, Math.Min(int.MaxValue, Math.Round((double)value)));
            return fallback;
        }

        public static bool Bool(Dictionary<string, object> map, string key, bool fallback)
        {
            object value = Get(map, key);
            return value is bool ? (bool)value : fallback;
        }

        public static List<object> Arr(Dictionary<string, object> map, string key)
        {
            return Get(map, key) as List<object>;
        }

        public static List<string> Strings(Dictionary<string, object> map, string key)
        {
            List<string> result = new List<string>();
            List<object> list = Arr(map, key);
            if (list == null) return result;
            foreach (object item in list)
            {
                string text = item as string;
                if (text != null) result.Add(text);
            }
            return result;
        }

        /// <summary>A box or point written as an array of numbers; null when it is not one of the right length.</summary>
        public static int[] Ints(object value, int length)
        {
            List<object> list = value as List<object>;
            if (list == null || list.Count != length) return null;
            int[] result = new int[length];
            for (int n = 0; n < length; n++)
            {
                if (list[n] is long) result[n] = (int)Math.Max(int.MinValue, Math.Min(int.MaxValue, (long)list[n]));
                else if (list[n] is double) result[n] = (int)Math.Round((double)list[n]);
                else return null;
            }
            return result;
        }
    }
}
