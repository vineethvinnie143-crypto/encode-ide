using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Encode.Sandbox
{
    /// <summary>Builds one flat JSON object. The helper's answers are small and have no nesting beyond lists of strings.</summary>
    internal sealed class JsonObject
    {
        private readonly List<string> parts = new List<string>();

        public static string Quote(string text)
        {
            if (text == null) return "null";
            StringBuilder sb = new StringBuilder(text.Length + 2);
            sb.Append('"');
            foreach (char c in text)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        // Everything outside printable ASCII is escaped, so the line is the same in any code page.
                        if (c < 0x20 || c > 0x7E) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        public JsonObject Text(string name, string value)
        {
            parts.Add(Quote(name) + ":" + Quote(value));
            return this;
        }

        public JsonObject Bool(string name, bool value)
        {
            parts.Add(Quote(name) + ":" + (value ? "true" : "false"));
            return this;
        }

        public JsonObject Number(string name, long value)
        {
            parts.Add(Quote(name) + ":" + value.ToString(CultureInfo.InvariantCulture));
            return this;
        }

        public JsonObject List(string name, IEnumerable<string> values)
        {
            List<string> items = new List<string>();
            foreach (string value in values) items.Add(Quote(value));
            parts.Add(Quote(name) + ":[" + string.Join(",", items.ToArray()) + "]");
            return this;
        }

        public override string ToString()
        {
            return "{" + string.Join(",", parts.ToArray()) + "}";
        }
    }
}
