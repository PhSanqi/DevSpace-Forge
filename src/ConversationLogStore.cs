using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace DevSpaceControlPlatform
{
    internal sealed class ConversationLogStore
    {
        private static readonly Regex WorkspaceIdPattern = new Regex("^[A-Za-z0-9._-]+$", RegexOptions.Compiled);
        private readonly object sync = new object();
        private readonly string directory;
        private readonly int maxMemoryLines;
        private readonly Dictionary<string, Queue<string>> buffers =
            new Dictionary<string, Queue<string>>(StringComparer.OrdinalIgnoreCase);

        public ConversationLogStore(string logsDirectory, int maxMemoryLines)
        {
            directory = Path.Combine(Path.GetFullPath(logsDirectory), "conversations");
            this.maxMemoryLines = Math.Max(10, maxMemoryLines);
        }

        public void Add(string workspaceId, string source, string line)
        {
            if (!IsWorkspaceId(workspaceId) || string.IsNullOrWhiteSpace(line)) return;
            var entry = DateTime.Now.ToString("HH:mm:ss") + " [" + source + "] " + line;
            lock (sync)
            {
                Queue<string> buffer;
                if (!buffers.TryGetValue(workspaceId, out buffer))
                {
                    buffer = new Queue<string>();
                    buffers[workspaceId] = buffer;
                }
                buffer.Enqueue(entry);
                while (buffer.Count > maxMemoryLines) buffer.Dequeue();
            }

            try
            {
                Directory.CreateDirectory(directory);
                File.AppendAllText(LogPath(workspaceId), DateTime.Now.ToString("yyyy-MM-dd ") + entry + Environment.NewLine, Encoding.UTF8);
            }
            catch
            {
            }
        }

        public string ReadRecent(string workspaceId)
        {
            if (!IsWorkspaceId(workspaceId)) return string.Empty;
            lock (sync)
            {
                Queue<string> buffer;
                if (buffers.TryGetValue(workspaceId, out buffer) && buffer.Count > 0)
                    return string.Join(Environment.NewLine, buffer.ToArray());
            }

            var path = LogPath(workspaceId);
            if (!File.Exists(path)) return string.Empty;
            try
            {
                var tail = new Queue<string>();
                foreach (var line in File.ReadLines(path, Encoding.UTF8))
                {
                    tail.Enqueue(line);
                    while (tail.Count > maxMemoryLines) tail.Dequeue();
                }
                return string.Join(Environment.NewLine, tail.ToArray());
            }
            catch
            {
                return string.Empty;
            }
        }

        public DateTime LastActivityUtc(string workspaceId)
        {
            if (!IsWorkspaceId(workspaceId)) return DateTime.MinValue;
            try
            {
                var path = LogPath(workspaceId);
                return File.Exists(path) ? File.GetLastWriteTimeUtc(path) : DateTime.MinValue;
            }
            catch
            {
                return DateTime.MinValue;
            }
        }

        public string[] KnownWorkspaceIds
        {
            get
            {
                var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                lock (sync)
                    foreach (var id in buffers.Keys) ids.Add(id);
                try
                {
                    if (Directory.Exists(directory))
                        foreach (var path in Directory.GetFiles(directory, "*.log"))
                        {
                            var id = Path.GetFileNameWithoutExtension(path);
                            if (IsWorkspaceId(id)) ids.Add(id);
                        }
                }
                catch
                {
                }
                return ids.ToArray();
            }
        }

        private string LogPath(string workspaceId)
        {
            return Path.Combine(directory, workspaceId + ".log");
        }

        private static bool IsWorkspaceId(string value)
        {
            return !string.IsNullOrWhiteSpace(value) && WorkspaceIdPattern.IsMatch(value);
        }
    }
}
