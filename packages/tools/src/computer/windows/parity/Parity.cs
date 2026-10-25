using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Encode.Desktop;

/// <summary>
/// Not part of the helper. A test program built from the helper's pure sources (Json, Geometry, Keys, Outline)
/// and driven from parity.test.ts: it reads one JSON document of cases on standard input and answers with one on
/// standard output, so the arithmetic, the key table and the outline rules of the C# side are checked against the
/// TypeScript the tool is written in.
/// </summary>
internal static class Parity
{
    private static int Main()
    {
        UTF8Encoding utf8 = new UTF8Encoding(false);
        string text = new StreamReader(Console.OpenStandardInput(), utf8).ReadToEnd();
        Dictionary<string, object> cases = Args.Obj(Json.Parse(text));
        Dictionary<string, object> answer = new Dictionary<string, object>();
        answer["fit"] = Fit(Args.Arr(cases, "fit"));
        answer["screen"] = Screen(Args.Arr(cases, "screen"));
        answer["keys"] = KeyTable(Args.Arr(cases, "keys"));
        answer["away"] = Away(Args.Arr(cases, "away"));
        answer["json"] = RoundTrip(Args.Arr(cases, "json"));
        answer["outline"] = Outlines(Args.Arr(cases, "outline"));
        answer["diff"] = Diffs(Args.Arr(cases, "diff"));
        answer["zoom"] = Zooms(Args.Arr(cases, "zoom"));
        answer["toImage"] = ToImage(Args.Arr(cases, "toImage"));
        answer["marks"] = Marks(Args.Arr(cases, "marks"));
        answer["gridStep"] = GridSteps(Args.Arr(cases, "gridStep"));
        answer["gridLines"] = GridLineCases(Args.Arr(cases, "gridLines"));
        StreamWriter writer = new StreamWriter(Console.OpenStandardOutput(), utf8);
        writer.Write(Json.Write(answer));
        writer.Flush();
        return 0;
    }

    private static List<object> Fit(List<object> cases)
    {
        List<object> results = new List<object>();
        if (cases == null) return results;
        foreach (object item in cases)
        {
            int[] c = Args.Ints(item, 4);
            int width;
            int height;
            double scale;
            Geo.FitImage(c[0], c[1], c[2], c[3], out width, out height, out scale);
            results.Add(new object[] { width, height, scale });
        }
        return results;
    }

    private static List<object> Screen(List<object> cases)
    {
        List<object> results = new List<object>();
        if (cases == null) return results;
        foreach (object item in cases)
        {
            List<object> c = (List<object>)item;
            int x;
            int y;
            Geo.ToScreen(Convert.ToInt32(c[0]), Convert.ToInt32(c[1]), new Box(Convert.ToInt32(c[2]), Convert.ToInt32(c[3]), Convert.ToInt32(c[4]), Convert.ToInt32(c[5])), Convert.ToDouble(c[6]), out x, out y);
            results.Add(new object[] { x, y });
        }
        return results;
    }

    private static List<object> KeyTable(List<object> names)
    {
        List<object> results = new List<object>();
        if (names == null) return results;
        foreach (object item in names)
        {
            string name = (string)item;
            KeyCode code;
            bool known = Keys.TryGet(name, out code);
            results.Add(new object[] { known, known ? (int)code.Vk : 0, known && code.Extended, Keys.Types(name) });
        }
        return results;
    }

    private static List<object> Away(List<object> cases)
    {
        List<object> results = new List<object>();
        if (cases == null) return results;
        foreach (object item in cases)
        {
            List<object> c = (List<object>)item;
            results.Add(Keys.LeavesTheWindow((bool)c[0], (bool)c[1], (string)c[2]));
        }
        return results;
    }

    private static List<object> RoundTrip(List<object> texts)
    {
        List<object> results = new List<object>();
        if (texts == null) return results;
        foreach (object item in texts)
        {
            Dictionary<string, object> result = new Dictionary<string, object>();
            try
            {
                result["text"] = Json.Write(Json.Parse((string)item));
                result["ok"] = true;
            }
            catch (Exception)
            {
                result["ok"] = false;
            }
            results.Add(result);
        }
        return results;
    }

    // ---------------------------------------------------------------- changed pictures

    /// <summary>A white picture with rectangles [x, y, width, height, brightness] painted on it.</summary>
    private static Frame Painted(int width, int height, int step, List<object> rectangles)
    {
        Frame frame = new Frame(width, height, step);
        for (int i = 0; i < frame.Luma.Length; i++) frame.Luma[i] = 255;
        if (rectangles == null) return frame;
        foreach (object rectangle in rectangles)
        {
            int[] r = Args.Ints(rectangle, 5);
            for (int y = r[1]; y < r[1] + r[3]; y++)
            {
                for (int x = r[0]; x < r[0] + r[2]; x++) frame.Luma[y * width + x] = (byte)r[4];
            }
        }
        return frame;
    }

    private static List<object> Diffs(List<object> cases)
    {
        List<object> results = new List<object>();
        if (cases == null) return results;
        foreach (object item in cases)
        {
            Dictionary<string, object> c = Args.Obj(item);
            int width = Args.Int(c, "width", 100);
            int height = Args.Int(c, "height", 100);
            int step = Args.Int(c, "step", 1);
            Frame a = Painted(width, height, step, Args.Arr(c, "a"));
            Frame b = Painted(Args.Int(c, "width2", width), Args.Int(c, "height2", height), step, Args.Arr(c, "b"));
            results.Add(Frames.Differs(a, b));
        }
        return results;
    }

    // ---------------------------------------------------------------- outlines

    private static NodeInfo Make(Dictionary<string, object> source)
    {
        NodeInfo node = new NodeInfo();
        node.Native = source;
        node.Role = Args.Str(source, "role", null);
        node.Name = Args.Str(source, "name", "");
        node.Can = Args.Strings(source, "can").ToArray();
        node.States = Args.Strings(source, "states").ToArray();
        node.Box = Box.FromJson(Args.Get(source, "box"));
        node.Offscreen = Args.Bool(source, "offscreen", false);
        node.Password = Args.Bool(source, "password", false);
        return node;
    }

    private static List<object> Outlines(List<object> cases)
    {
        List<object> results = new List<object>();
        if (cases == null) return results;
        foreach (object item in cases)
        {
            Dictionary<string, object> c = Args.Obj(item);
            OutlineLimits limits = new OutlineLimits();
            Dictionary<string, object> given = Args.Obj(Args.Get(c, "limits"));
            limits.MaxEntries = Args.Int(given, "maxEntries", limits.MaxEntries);
            limits.MaxVisits = Args.Int(given, "maxVisits", limits.MaxVisits);
            limits.MaxDepth = Args.Int(given, "maxDepth", limits.MaxDepth);
            limits.MaxChildren = Args.Int(given, "maxChildren", limits.MaxChildren);
            Box window = Box.FromJson(Args.Get(c, "window"));
            NodeInfo root = Make(Args.Obj(Args.Get(c, "root")));
            OutlineResult result = OutlineBuilder.Build(root, delegate(NodeInfo parent)
            {
                List<NodeInfo> kids = new List<NodeInfo>();
                List<object> children = Args.Arr((Dictionary<string, object>)parent.Native, "children");
                if (children != null) foreach (object child in children) kids.Add(Make(Args.Obj(child)));
                return kids;
            }, window, limits);

            List<object> entries = new List<object>();
            foreach (OutlineEntry entry in result.Entries) entries.Add(new object[] { entry.Node.Role, entry.Node.Name, entry.Depth });
            List<object> passwords = new List<object>();
            foreach (Box box in result.Passwords) passwords.Add(box.ToJson());
            Dictionary<string, object> answer = new Dictionary<string, object>();
            answer["entries"] = entries;
            answer["total"] = result.Total;
            answer["cut"] = result.Cut;
            answer["passwords"] = passwords;
            results.Add(answer);
        }
        return results;
    }

    // ---------------------------------------------------------------- marks and grids (ADR 0121)

    private static List<object> Zooms(List<object> cases)
    {
        List<object> results = new List<object>();
        if (cases == null) return results;
        foreach (object item in cases)
        {
            int[] c = Args.Ints(item, 4);
            int width;
            int height;
            double scale;
            Geo.FitZoom(c[0], c[1], c[2], c[3], out width, out height, out scale);
            results.Add(new object[] { width, height, scale });
        }
        return results;
    }

    private static List<object> ToImage(List<object> cases)
    {
        List<object> results = new List<object>();
        if (cases == null) return results;
        foreach (object item in cases)
        {
            List<object> c = (List<object>)item;
            Box box = Geo.BoxToImage(Box.FromJson(c[0]), Box.FromJson(c[1]), Convert.ToDouble(c[2]), Convert.ToInt32(c[3]), Convert.ToInt32(c[4]));
            results.Add(box.ToJson());
        }
        return results;
    }

    /// <summary>Each case: { width, height, max, candidates: [[label, role, [x, y, w, h], acts]] }; the answer, each mark as [label, box, border, tag, color].</summary>
    private static List<object> Marks(List<object> cases)
    {
        List<object> results = new List<object>();
        if (cases == null) return results;
        foreach (object item in cases)
        {
            Dictionary<string, object> c = Args.Obj(item);
            List<MarkCandidate> candidates = new List<MarkCandidate>();
            foreach (object raw in Args.Arr(c, "candidates"))
            {
                List<object> fields = (List<object>)raw;
                MarkCandidate candidate = new MarkCandidate();
                candidate.Label = (string)fields[0];
                candidate.Role = fields[1] as string;
                candidate.Box = Box.FromJson(fields[2]);
                candidate.Acts = (bool)fields[3];
                candidates.Add(candidate);
            }
            List<object> marks = new List<object>();
            foreach (PlacedMark mark in MarkPlan.Place(candidates, Args.Int(c, "width", 0), Args.Int(c, "height", 0), 7, 14, Args.Int(c, "max", MarkPlan.MaxMarks)))
            {
                marks.Add(new object[] { mark.Label, mark.Box.ToJson(), mark.Border, mark.Tag.ToJson(), mark.Color });
            }
            results.Add(marks);
        }
        return results;
    }

    private static List<object> GridSteps(List<object> cases)
    {
        List<object> results = new List<object>();
        if (cases == null) return results;
        foreach (object item in cases)
        {
            List<object> c = (List<object>)item;
            results.Add(GridPlan.Step(Convert.ToDouble(c[0]), Convert.ToDouble(c[1]), Convert.ToInt32(c[2]), Convert.ToInt32(c[3])));
        }
        return results;
    }

    private static List<object> GridLineCases(List<object> cases)
    {
        List<object> results = new List<object>();
        if (cases == null) return results;
        foreach (object item in cases)
        {
            List<object> c = (List<object>)item;
            List<object> lines = new List<object>();
            foreach (int line in GridPlan.Lines(Convert.ToDouble(c[0]), Convert.ToDouble(c[1]), Convert.ToInt32(c[2]))) lines.Add(line);
            results.Add(lines);
        }
        return results;
    }
}
