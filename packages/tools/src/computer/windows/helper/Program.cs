using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;

namespace Encode.Desktop
{
    /// <summary>
    /// The helper's process: one request per line on standard input, one answer per line on standard output.
    /// Standard output carries nothing else; stray writes are sent to standard error. When the parent goes
    /// away the input closes and the helper lets go of anything it holds and exits.
    /// </summary>
    internal static class Program
    {
        private sealed class Request
        {
            public long Id;
            public string Op;
            public Dictionary<string, object> Args;
            public Cancel Cancel = new Cancel();
        }

        private static readonly object WriteLock = new object();
        private static readonly object QueueLock = new object();
        private static readonly Queue<Request> Queue = new Queue<Request>();
        private static readonly Dictionary<long, Request> Live = new Dictionary<long, Request>();
        private static readonly AutoResetEvent Signal = new AutoResetEvent(false);
        private static Stream output;

        private static void EnableDpiAwareness()
        {
            // The manifest asks for per-monitor awareness before anything else runs; this is for a copy started without it.
            try
            {
                if (Native.SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
            }
            catch (EntryPointNotFoundException)
            {
            }
            try
            {
                Native.SetProcessDPIAware();
            }
            catch (EntryPointNotFoundException)
            {
            }
        }

        private static void Write(object message)
        {
            byte[] bytes = new UTF8Encoding(false).GetBytes(Json.Write(message) + "\n");
            lock (WriteLock)
            {
                output.Write(bytes, 0, bytes.Length);
                output.Flush();
            }
        }

        private static void Reply(long id, object result, HelperException failure)
        {
            Dictionary<string, object> message = new Dictionary<string, object>();
            message["id"] = id;
            if (failure == null)
            {
                message["ok"] = true;
                message["result"] = result;
            }
            else
            {
                message["ok"] = false;
                Dictionary<string, object> error = new Dictionary<string, object>();
                error["code"] = failure.Code;
                error["message"] = failure.Message;
                message["error"] = error;
            }
            Write(message);
        }

        private static void ReadLoop(TextReader reader)
        {
            string line;
            while ((line = reader.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                Dictionary<string, object> message;
                try
                {
                    message = Args.Obj(Json.Parse(line));
                }
                catch (FormatException)
                {
                    continue;
                }
                if (message == null) continue;
                string op = Args.Str(message, "op", "");
                long id = (long)Args.Int(message, "id", 0);
                if (op == "cancel")
                {
                    lock (QueueLock)
                    {
                        Request target;
                        if (Live.TryGetValue(id, out target)) target.Cancel.Set();
                    }
                    continue;
                }
                Request request = new Request();
                request.Id = id;
                request.Op = op;
                request.Args = Args.Obj(Args.Get(message, "args")) ?? new Dictionary<string, object>();
                lock (QueueLock)
                {
                    Live[id] = request;
                    Queue.Enqueue(request);
                }
                Signal.Set();
            }
            // The input closed: the parent is gone, or asked us to stop.
            lock (QueueLock)
            {
                Queue.Enqueue(null);
            }
            Signal.Set();
        }

        private static Request Next()
        {
            while (true)
            {
                lock (QueueLock)
                {
                    if (Queue.Count > 0) return Queue.Dequeue();
                }
                Signal.WaitOne();
            }
        }

        private static int Main(string[] args)
        {
            CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
            CultureInfo.DefaultThreadCurrentUICulture = CultureInfo.InvariantCulture;
            Thread.CurrentThread.CurrentCulture = CultureInfo.InvariantCulture;
            Thread.CurrentThread.CurrentUICulture = CultureInfo.InvariantCulture;
            EnableDpiAwareness();

            output = Console.OpenStandardOutput();
            TextReader reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false), false, 1 << 16);
            Console.SetOut(Console.Error);

            Session session = new Session();
            Thread readThread = new Thread(delegate() { ReadLoop(reader); });
            readThread.IsBackground = true;
            readThread.Name = "encode-read";
            readThread.Start();

            Dictionary<string, object> hello = new Dictionary<string, object>();
            hello["event"] = "hello";
            hello["protocol"] = 1;
            hello["version"] = Session.Version;
            hello["pid"] = System.Diagnostics.Process.GetCurrentProcess().Id;
            Write(hello);

            while (true)
            {
                Request request = Next();
                if (request == null) break;
                object result = null;
                HelperException failure = null;
                try
                {
                    request.Cancel.Check();
                    result = session.Handle(request.Op, request.Args, request.Cancel);
                }
                catch (HelperException error)
                {
                    failure = error;
                }
                catch (Exception error)
                {
                    string message = string.IsNullOrEmpty(error.Message) ? error.GetType().Name : error.Message;
                    failure = new HelperException("failed", message);
                }
                lock (QueueLock)
                {
                    Live.Remove(request.Id);
                }
                try
                {
                    Reply(request.Id, result, failure);
                }
                catch (Exception)
                {
                    break;
                }
            }
            session.Shutdown();
            return 0;
        }
    }
}
