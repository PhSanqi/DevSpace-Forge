using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace DevSpaceControlPlatform
{
    internal sealed class RuntimeConsoleJob
    {
        public string Id { get; set; }
        public string Status { get; set; }
        public string WorkspaceId { get; set; }
        public string WorkspaceRoot { get; set; }
        public string Command { get; set; }
        public long CreatedAt { get; set; }
    }

    internal sealed class RuntimeConsoleWorkspace
    {
        public string Id { get; set; }
        public string Root { get; set; }
        public long LastUsedAt { get; set; }
    }

    internal sealed class RuntimeConsoleSnapshot
    {
        public string RuntimeVersion { get; set; }
        public string ActiveSlot { get; set; }
        public string ServerHash { get; set; }
        public string[] RuntimeSlots { get; set; }
        public RuntimeConsoleJob[] Jobs { get; set; }
        public RuntimeConsoleWorkspace[] Workspaces { get; set; }
        public string[] RecentRequests { get; set; }
    }

    internal static class RuntimeConsoleReader
    {
        public static RuntimeConsoleSnapshot Read(string platformRoot)
        {
            var root = Path.GetFullPath(platformRoot);
            var packageRoot = TryPackageRoot(root);
            var snapshot = new RuntimeConsoleSnapshot
            {
                RuntimeVersion = ReadRuntimeVersion(packageRoot),
                ActiveSlot = RuntimeResolver.ActiveRuntimeSlot(root) ?? string.Empty,
                ServerHash = FileHash(packageRoot == null ? null : Path.Combine(packageRoot, "dist", "server.js")),
                RuntimeSlots = ReadSlots(root),
                Jobs = new RuntimeConsoleJob[0],
                Workspaces = new RuntimeConsoleWorkspace[0],
                RecentRequests = ReadRecentRequests(root, 40)
            };

            if (packageRoot != null)
            {
                try
                {
                    ReadStateDatabases(root, packageRoot, snapshot);
                }
                catch
                {
                    // Runtime Console is diagnostic-only. Missing/corrupt state must
                    // not take down the Control Platform.
                }
            }
            return snapshot;
        }

        public static string Format(
            RuntimeConsoleSnapshot snapshot,
            string devSpaceStatus,
            string tunnelStatus,
            string readinessStatus)
        {
            var builder = new StringBuilder();
            builder.AppendLine("INSTANCE / RUNTIME");
            builder.AppendLine("  version: " + Empty(snapshot.RuntimeVersion, "unknown"));
            builder.AppendLine("  active-slot: " + Empty(snapshot.ActiveSlot, "legacy/default"));
            builder.AppendLine("  dist/server.js sha256: " + Empty(snapshot.ServerHash, "unavailable"));
            builder.AppendLine("  slots: " + (snapshot.RuntimeSlots.Length == 0 ? "(none)" : string.Join(", ", snapshot.RuntimeSlots)));
            builder.AppendLine();
            builder.AppendLine("READINESS / TUNNEL");
            builder.AppendLine("  DevSpace: " + Empty(devSpaceStatus, "unknown"));
            builder.AppendLine("  Tunnel: " + Empty(tunnelStatus, "unknown"));
            builder.AppendLine("  Readiness: " + Empty(readinessStatus, "unknown"));
            builder.AppendLine();
            builder.AppendLine("DURABLE JOBS");
            if (snapshot.Jobs.Length == 0) builder.AppendLine("  (none)");
            foreach (var job in snapshot.Jobs.Take(20))
                builder.AppendLine("  " + job.Status + "  " + job.Id + "  " +
                    Empty(job.WorkspaceRoot, job.WorkspaceId) + "  " + Clip(job.Command, 96));
            builder.AppendLine();
            builder.AppendLine("WORKSPACES / SESSIONS");
            if (snapshot.Workspaces.Length == 0) builder.AppendLine("  (none)");
            foreach (var workspace in snapshot.Workspaces.Take(20))
                builder.AppendLine("  " + workspace.Id + "  " + workspace.Root);
            builder.AppendLine();
            builder.AppendLine("RECENT MCP / REQUEST DIAGNOSTICS");
            if (snapshot.RecentRequests.Length == 0) builder.AppendLine("  (none)");
            foreach (var line in snapshot.RecentRequests) builder.AppendLine("  " + line);
            return builder.ToString();
        }

        private static string TryPackageRoot(string root)
        {
            try { return RuntimeResolver.ResolveDevSpacePackageRoot(root); }
            catch { return null; }
        }

        private static string ReadRuntimeVersion(string packageRoot)
        {
            if (string.IsNullOrWhiteSpace(packageRoot)) return string.Empty;
            try
            {
                var path = Path.Combine(packageRoot, "package.json");
                var value = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(
                    File.ReadAllText(path, Encoding.UTF8));
                object version;
                return value != null && value.TryGetValue("version", out version)
                    ? Convert.ToString(version)
                    : string.Empty;
            }
            catch { return string.Empty; }
        }

        private static string[] ReadSlots(string root)
        {
            try
            {
                var path = Path.Combine(root, "runtime", "slots");
                if (!Directory.Exists(path)) return new string[0];
                return Directory.GetDirectories(path)
                    .Where(v => File.Exists(Path.Combine(v, "READY")))
                    .Select(Path.GetFileName)
                    .OrderBy(v => v, StringComparer.OrdinalIgnoreCase)
                    .ToArray();
            }
            catch { return new string[0]; }
        }

        private static string FileHash(string path)
        {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return string.Empty;
            try
            {
                using (var stream = File.OpenRead(path))
                using (var sha = SHA256.Create())
                    return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", string.Empty).ToLowerInvariant();
            }
            catch { return string.Empty; }
        }

        private static string[] ReadRecentRequests(string root, int limit)
        {
            var path = Path.Combine(root, "logs", "devspace-service.log");
            if (!File.Exists(path)) return new string[0];
            try
            {
                return File.ReadLines(path, Encoding.UTF8)
                    .Where(v =>
                        v.IndexOf("http_request", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        v.IndexOf("mcp_request", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        v.IndexOf("tool_call", StringComparison.OrdinalIgnoreCase) >= 0)
                    .Reverse()
                    .Take(limit)
                    .Reverse()
                    .ToArray();
            }
            catch { return new string[0]; }
        }

        private static void ReadStateDatabases(
            string root,
            string packageRoot,
            RuntimeConsoleSnapshot snapshot)
        {
            var scopeDirectory = Directory.GetParent(packageRoot);
            var nodeModulesDirectory = scopeDirectory == null ? null : scopeDirectory.Parent;
            if (nodeModulesDirectory == null) return;
            var sqliteModule = Path.Combine(nodeModulesDirectory.FullName, "better-sqlite3");
            if (!Directory.Exists(sqliteModule)) return;

            var stateRoot = Path.Combine(root, "state", "devspace-state");
            var workspaceDb = Path.Combine(stateRoot, "devspace.sqlite");
            var jobsDb = Path.Combine(stateRoot, "jobs", "jobs.sqlite");
            var scriptPath = Path.Combine(
                Path.GetTempPath(),
                "devspace-runtime-console-" + Guid.NewGuid().ToString("N") + ".js");
            try
            {
                File.WriteAllText(
                    scriptPath,
                    "const Database=require(process.argv[2]);" +
                    "const ws=process.argv[3],jobs=process.argv[4];" +
                    "const out={workspaces:[],jobs:[]};" +
                    "if(require('fs').existsSync(ws)){const d=new Database(ws,{readonly:true,fileMustExist:true});" +
                    "try{out.workspaces=d.prepare(\"select id, root, last_used_at as lastUsedAt from workspace_sessions order by last_used_at desc limit 50\").all();}finally{d.close();}}" +
                    "if(require('fs').existsSync(jobs)){const d=new Database(jobs,{readonly:true,fileMustExist:true});" +
                    "try{out.jobs=d.prepare(\"select id,status,workspace_id as workspaceId,workspace_root as workspaceRoot,command,created_at as createdAt from durable_jobs order by created_at desc limit 50\").all();}finally{d.close();}}" +
                    "process.stdout.write(JSON.stringify(out));",
                    new UTF8Encoding(false));

                var info = new ProcessStartInfo
                {
                    FileName = RuntimeResolver.ResolveNodePath(root),
                    Arguments = Quote(scriptPath) + " " + Quote(sqliteModule) + " " +
                        Quote(workspaceDb) + " " + Quote(jobsDb),
                    WorkingDirectory = root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                using (var process = Process.Start(info))
                {
                    var output = process.StandardOutput.ReadToEnd();
                    process.StandardError.ReadToEnd();
                    process.WaitForExit(3000);
                    if (!process.HasExited || process.ExitCode != 0 || string.IsNullOrWhiteSpace(output)) return;
                    var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(output);
                    snapshot.Workspaces = ConvertWorkspaces(data);
                    snapshot.Jobs = ConvertJobs(data);
                }
            }
            finally
            {
                try { if (File.Exists(scriptPath)) File.Delete(scriptPath); }
                catch { }
            }
        }

        private static RuntimeConsoleWorkspace[] ConvertWorkspaces(Dictionary<string, object> data)
        {
            object raw;
            var rows = data != null && data.TryGetValue("workspaces", out raw)
                ? raw as object[]
                : null;
            if (rows == null) return new RuntimeConsoleWorkspace[0];
            return rows
                .OfType<Dictionary<string, object>>()
                .Select(row => new RuntimeConsoleWorkspace
                {
                    Id = Field(row, "id"),
                    Root = Field(row, "root"),
                    LastUsedAt = LongField(row, "lastUsedAt")
                })
                .ToArray();
        }

        private static RuntimeConsoleJob[] ConvertJobs(Dictionary<string, object> data)
        {
            object raw;
            var rows = data != null && data.TryGetValue("jobs", out raw)
                ? raw as object[]
                : null;
            if (rows == null) return new RuntimeConsoleJob[0];
            return rows
                .OfType<Dictionary<string, object>>()
                .Select(row => new RuntimeConsoleJob
                {
                    Id = Field(row, "id"),
                    Status = Field(row, "status"),
                    WorkspaceId = Field(row, "workspaceId"),
                    WorkspaceRoot = Field(row, "workspaceRoot"),
                    Command = Field(row, "command"),
                    CreatedAt = LongField(row, "createdAt")
                })
                .ToArray();
        }

        private static string Field(Dictionary<string, object> row, string name)
        {
            object value;
            return row != null && row.TryGetValue(name, out value) ? Convert.ToString(value) : string.Empty;
        }

        private static long LongField(Dictionary<string, object> row, string name)
        {
            object value;
            long parsed;
            return row != null && row.TryGetValue(name, out value) &&
                long.TryParse(Convert.ToString(value), out parsed) ? parsed : 0L;
        }

        private static string Quote(string value)
        {
            return new JavaScriptSerializer().Serialize(value);
        }

        private static string Empty(string value, string fallback)
        {
            return string.IsNullOrWhiteSpace(value) ? fallback : value;
        }

        private static string Clip(string value, int max)
        {
            if (string.IsNullOrWhiteSpace(value)) return string.Empty;
            return value.Length <= max ? value : value.Substring(0, max - 1) + "…";
        }
    }
}
