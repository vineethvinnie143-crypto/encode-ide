using System;
using System.Threading;

namespace Encode.Desktop
{
    /// <summary>A failure the model can be told about. The code is one of DesktopErrorCode in contract.ts.</summary>
    internal sealed class HelperException : Exception
    {
        public readonly string Code;

        public HelperException(string code, string message) : base(message)
        {
            Code = code;
        }
    }

    /// <summary>Set when the client gives up on a request, so a long one stops at its next safe point.</summary>
    internal sealed class Cancel
    {
        private volatile bool cancelled;

        public bool IsCancelled { get { return cancelled; } }

        public void Set()
        {
            cancelled = true;
        }

        public void Check()
        {
            if (cancelled) throw new HelperException("failed", "Cancelled.");
        }

        /// <summary>Sleeps, but wakes early when cancelled.</summary>
        public static void Sleep(Cancel cancel, int ms)
        {
            int left = ms;
            while (left > 0)
            {
                if (cancel != null) cancel.Check();
                int slice = Math.Min(left, 40);
                Thread.Sleep(slice);
                left -= slice;
            }
            if (cancel != null) cancel.Check();
        }
    }
}
