using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;

namespace DevSpaceControlPlatform
{
    internal sealed class DevSpaceSecurityReport
    {
        public List<string> Errors { get; private set; }
        public List<string> Warnings { get; private set; }

        public bool IsSafe
        {
            get { return Errors.Count == 0; }
        }

        public DevSpaceSecurityReport()
        {
            Errors = new List<string>();
            Warnings = new List<string>();
        }
    }

    internal static class DevSpaceEffectiveStateVerifier
    {
        private static readonly string[] RemovedModernEnvironmentKeys =
        {
            "DEVSPACE_SUBAGENTS",
            "DEVSPACE_TOOL_MODE",
            "DEVSPACE_MINIMAL_TOOLS",
            "DEVSPACE_WIDGETS",
            "DEVSPACE_PUBLIC_BASE_URL",
            "DEVSPACE_ALLOWED_HOSTS",
            "DEVSPACE_TRUST_PROXY",
            "DEVSPACE_ALLOWED_ROOTS",
            "DEVSPACE_WORKTREE_ROOT",
            "DEVSPACE_STATE_DIR",
            "DEVSPACE_ARTIFACTS",
            "DEVSPACE_ARTIFACT_MAX_FILE_BYTES",
            "DEVSPACE_SKILLS",
            "DEVSPACE_SKILL_PATHS",
            "DEVSPACE_AGENT_DIR",
            "DEVSPACE_LOG_LEVEL",
            "DEVSPACE_LOG_FORMAT",
            "DEVSPACE_LOG_REQUESTS",
            "DEVSPACE_LOG_ASSETS",
            "DEVSPACE_LOG_TOOL_CALLS",
            "DEVSPACE_LOG_SHELL_COMMANDS"
        };

        public static DevSpaceSecurityReport Verify(
            DevSpaceLaunchPlan plan,
            string platformRoot)
        {
            if (plan == null) throw new ArgumentNullException("plan");
            var report = new DevSpaceSecurityReport();
            var json = ParseConfig(plan.SerializedConfig, report);
            if (json == null) return report;

            VerifyManagedConfigPath(plan, platformRoot, report);
            if (plan.Version.Family == DevSpaceConfigFamily.Legacy10)
            {
                VerifyLegacy(plan, json, report);
            }
            else
            {
                VerifyModern(plan, json, report);
            }
            return report;
        }

        private static void VerifyManagedConfigPath(
            DevSpaceLaunchPlan plan,
            string platformRoot,
            DevSpaceSecurityReport report)
        {
            if (string.IsNullOrWhiteSpace(platformRoot))
            {
                report.Errors.Add("Platform root 不能为空。");
                return;
            }

            var root = NormalizeDirectory(platformRoot);
            var config = NormalizeDirectory(plan.ConfigDirectory);
            if (!IsSameOrInside(config, root))
            {
                report.Errors.Add("Managed DevSpace config directory 位于控制平台目录之外。");
            }
        }

        private static void VerifyLegacy(
            DevSpaceLaunchPlan plan,
            Dictionary<string, object> json,
            DevSpaceSecurityReport report)
        {
            object storedSubagents;
            if (!json.TryGetValue("subagents", out storedSubagents) || !object.Equals(storedSubagents, false))
            {
                report.Errors.Add("DevSpace 1.0.x 持久配置没有明确关闭 subagents。");
            }

            string effectiveSubagents;
            if (!plan.EnvironmentVariables.TryGetValue("DEVSPACE_SUBAGENTS", out effectiveSubagents) ||
                !IsFalse(effectiveSubagents))
            {
                report.Errors.Add("DevSpace 1.0.x 启动环境没有有效关闭 subagents。");
            }

            VerifyHost(json, report);
            VerifyAllowedHosts(json, report);
            VerifyAllowedRoots(json, "allowedRoots", report);

            string shellLog;
            if (plan.EnvironmentVariables.TryGetValue("DEVSPACE_LOG_SHELL_COMMANDS", out shellLog) &&
                !IsFalse(shellLog))
            {
                report.Warnings.Add("Shell command logging 已开启，命令参数可能包含敏感信息。");
            }
        }

        private static void VerifyModern(
            DevSpaceLaunchPlan plan,
            Dictionary<string, object> json,
            DevSpaceSecurityReport report)
        {
            foreach (var key in RemovedModernEnvironmentKeys)
            {
                if (plan.EnvironmentVariables.ContainsKey(key))
                {
                    report.Errors.Add("DevSpace 1.1.x 不应再通过环境变量设置 " + key + "。");
                }
            }

            var server = Child(json, "server", report);
            var workspaces = Child(json, "workspaces", report);
            var subagents = Child(json, "subagents", report);
            var logging = Child(json, "logging", report);
            if (server == null || workspaces == null || subagents == null || logging == null) return;

            object enabled;
            if (!subagents.TryGetValue("enabled", out enabled) || !object.Equals(enabled, false))
            {
                report.Errors.Add("DevSpace 1.1.x effective config 没有关闭 subagents。");
            }

            VerifyHost(server, report);
            VerifyAllowedHosts(server, report);
            VerifyAllowedRoots(workspaces, "allowedRoots", report);

            object shellCommands;
            if (logging.TryGetValue("shellCommands", out shellCommands) && object.Equals(shellCommands, true))
            {
                report.Warnings.Add("Shell command logging 已开启，命令参数可能包含敏感信息。");
            }

            object trustProxy;
            object publicBaseUrl;
            if (server.TryGetValue("trustProxy", out trustProxy) && object.Equals(trustProxy, true) &&
                server.TryGetValue("publicBaseUrl", out publicBaseUrl) && publicBaseUrl == null)
            {
                report.Warnings.Add("trustProxy 已开启，但 publicBaseUrl 为空；仅在实际使用受控反向代理时启用。");
            }
        }

        private static void VerifyHost(
            Dictionary<string, object> config,
            DevSpaceSecurityReport report)
        {
            object hostValue;
            var host = config.TryGetValue("host", out hostValue) ? Convert.ToString(hostValue) : string.Empty;
            if (!string.Equals(host, "127.0.0.1", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(host, "::1", StringComparison.OrdinalIgnoreCase))
            {
                report.Errors.Add("DevSpace server.host 必须保持 loopback；当前为 " + host + "。");
            }
        }

        private static void VerifyAllowedHosts(
            Dictionary<string, object> config,
            DevSpaceSecurityReport report)
        {
            object hostsValue;
            if (!config.TryGetValue("allowedHosts", out hostsValue)) return;
            foreach (var host in AsArray(hostsValue))
            {
                if (string.Equals(Convert.ToString(host), "*", StringComparison.Ordinal))
                {
                    report.Errors.Add("server.allowedHosts 不能包含 '*'。");
                    return;
                }
            }
        }

        private static void VerifyAllowedRoots(
            Dictionary<string, object> config,
            string key,
            DevSpaceSecurityReport report)
        {
            object rootsValue;
            if (!config.TryGetValue(key, out rootsValue))
            {
                report.Errors.Add("DevSpace allowed roots 缺失。");
                return;
            }

            var roots = AsArray(rootsValue);
            if (roots.Length == 0)
            {
                report.Errors.Add("DevSpace allowed roots 不能为空。");
                return;
            }

            var userProfile = NormalizeDirectory(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
            foreach (var item in roots)
            {
                var rootText = Convert.ToString(item);
                if (string.IsNullOrWhiteSpace(rootText))
                {
                    report.Errors.Add("DevSpace allowed root 不能为空。");
                    continue;
                }

                var root = NormalizeDirectory(rootText);
                var driveRoot = NormalizeDirectory(Path.GetPathRoot(root));
                if (string.Equals(root, driveRoot, StringComparison.OrdinalIgnoreCase))
                {
                    report.Errors.Add("拒绝将整个磁盘作为 DevSpace allowed root：" + root);
                }
                if (string.Equals(root, userProfile, StringComparison.OrdinalIgnoreCase))
                {
                    report.Errors.Add("拒绝将整个 Windows 用户目录作为 DevSpace allowed root：" + root);
                }
                if (!Directory.Exists(root))
                {
                    report.Errors.Add("DevSpace allowed root 不存在：" + root);
                }
            }
        }

        private static Dictionary<string, object> ParseConfig(
            string serializedConfig,
            DevSpaceSecurityReport report)
        {
            try
            {
                var serializer = new JavaScriptSerializer();
                var parsed = serializer.DeserializeObject(serializedConfig) as Dictionary<string, object>;
                if (parsed == null) report.Errors.Add("DevSpace config 不是 JSON object。");
                return parsed;
            }
            catch (Exception exception)
            {
                report.Errors.Add("无法解析待应用的 DevSpace config：" + exception.Message);
                return null;
            }
        }

        private static Dictionary<string, object> Child(
            Dictionary<string, object> parent,
            string key,
            DevSpaceSecurityReport report)
        {
            object value;
            var child = parent.TryGetValue(key, out value) ? value as Dictionary<string, object> : null;
            if (child == null) report.Errors.Add("DevSpace config 缺少 " + key + " section。");
            return child;
        }

        private static object[] AsArray(object value)
        {
            return value as object[] ?? new object[0];
        }

        private static bool IsFalse(string value)
        {
            return string.Equals(value, "0", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(value, "false", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(value, "no", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(value, "off", StringComparison.OrdinalIgnoreCase);
        }

        private static string NormalizeDirectory(string path)
        {
            var full = Path.GetFullPath(path ?? string.Empty);
            var root = Path.GetPathRoot(full);
            if (string.Equals(full, root, StringComparison.OrdinalIgnoreCase)) return full;
            return full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }

        private static bool IsSameOrInside(string path, string root)
        {
            if (string.Equals(path, root, StringComparison.OrdinalIgnoreCase)) return true;
            return path.StartsWith(
                root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar,
                StringComparison.OrdinalIgnoreCase);
        }
    }
}
