using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace DevSpaceControlPlatform
{
    internal sealed class DevSpaceCommandResult
    {
        public int ExitCode { get; set; }
        public string StandardOutput { get; set; }
        public string StandardError { get; set; }

        public bool Success
        {
            get { return ExitCode == 0; }
        }
    }

    internal sealed class DevSpaceCliRunner
    {
        private static readonly Regex ReviewRefRegex = new Regex(
            "^[0-9a-fA-F]{40,64}$",
            RegexOptions.Compiled);

        private readonly string nodePath;
        private readonly string cliPath;
        private readonly DevSpaceLaunchPlan plan;
        private readonly string defaultWorkingDirectory;

        public DevSpaceCliRunner(
            string nodePath,
            string cliPath,
            DevSpaceLaunchPlan plan,
            string defaultWorkingDirectory)
        {
            if (string.IsNullOrWhiteSpace(nodePath)) throw new ArgumentException("Node path 不能为空。", "nodePath");
            if (string.IsNullOrWhiteSpace(cliPath)) throw new ArgumentException("DevSpace CLI path 不能为空。", "cliPath");
            if (plan == null) throw new ArgumentNullException("plan");

            this.nodePath = nodePath;
            this.cliPath = cliPath;
            this.plan = plan;
            this.defaultWorkingDirectory = string.IsNullOrWhiteSpace(defaultWorkingDirectory)
                ? Environment.CurrentDirectory
                : Path.GetFullPath(defaultWorkingDirectory);
        }

        public DevSpaceCommandResult Doctor()
        {
            return Run("doctor", defaultWorkingDirectory, 15000);
        }

        public DevSpaceCommandResult ConfigGet()
        {
            return Run("config get", defaultWorkingDirectory, 10000);
        }

        public DevSpaceCommandResult ShowChanges(string reviewRef, string workspaceDirectory)
        {
            if (plan.Version.Family != DevSpaceConfigFamily.Modern11)
            {
                throw new NotSupportedException("本地 devspace show-changes CLI 入口仅在当前 1.1.x 路径中使用。");
            }
            if (!ReviewRefRegex.IsMatch(reviewRef ?? string.Empty))
            {
                throw new ArgumentException("reviewRef 必须是 DevSpace 返回的 40-64 位十六进制引用。", "reviewRef");
            }
            if (string.IsNullOrWhiteSpace(workspaceDirectory) || !Directory.Exists(workspaceDirectory))
            {
                throw new DirectoryNotFoundException("show-changes workspace 不存在：" + workspaceDirectory);
            }
            return Run("show-changes " + reviewRef.ToLowerInvariant() + " --json", workspaceDirectory, 15000);
        }

        public DevSpaceCommandResult Run(string arguments, string workingDirectory, int timeoutMs)
        {
            if (!File.Exists(nodePath)) throw new FileNotFoundException("找不到 Node.js。", nodePath);
            if (!File.Exists(cliPath)) throw new FileNotFoundException("找不到 DevSpace CLI。", cliPath);
            if (timeoutMs <= 0) throw new ArgumentOutOfRangeException("timeoutMs");

            var startInfo = new ProcessStartInfo
            {
                FileName = nodePath,
                Arguments = Quote(cliPath) + " " + (arguments ?? string.Empty),
                WorkingDirectory = Path.GetFullPath(workingDirectory ?? defaultWorkingDirectory),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            ApplyManagedEnvironment(startInfo, plan.EnvironmentVariables);

            var stdout = new StringBuilder();
            var stderr = new StringBuilder();
            using (var process = new Process())
            {
                process.StartInfo = startInfo;
                process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args)
                {
                    if (args.Data != null) stdout.AppendLine(args.Data);
                };
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args)
                {
                    if (args.Data != null) stderr.AppendLine(args.Data);
                };

                if (!process.Start()) throw new InvalidOperationException("DevSpace CLI 进程没有启动。");
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                if (!process.WaitForExit(timeoutMs))
                {
                    try { process.Kill(); }
                    catch { }
                    throw new TimeoutException("DevSpace CLI 命令超时：" + arguments);
                }
                process.WaitForExit();

                return new DevSpaceCommandResult
                {
                    ExitCode = process.ExitCode,
                    StandardOutput = stdout.ToString().TrimEnd(),
                    StandardError = stderr.ToString().TrimEnd()
                };
            }
        }

        internal static void ApplyManagedEnvironment(
            ProcessStartInfo startInfo,
            IDictionary<string, string> managedEnvironment)
        {
            var devSpaceKeys = new List<string>();
            foreach (DictionaryEntry entry in startInfo.EnvironmentVariables)
            {
                var key = Convert.ToString(entry.Key);
                if (key.StartsWith("DEVSPACE_", StringComparison.OrdinalIgnoreCase)) devSpaceKeys.Add(key);
            }
            foreach (var key in devSpaceKeys) startInfo.EnvironmentVariables.Remove(key);
            foreach (var pair in managedEnvironment) startInfo.EnvironmentVariables[pair.Key] = pair.Value;
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }
    }
}
