using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace DevSpaceControlPlatform
{
    internal enum DevSpaceConfigFamily
    {
        Legacy10,
        Modern11
    }

    internal sealed class DevSpaceVersion
    {
        private static readonly Regex VersionRegex = new Regex(
            @"(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)",
            RegexOptions.Compiled);

        public string Raw { get; private set; }
        public int Major { get; private set; }
        public int Minor { get; private set; }
        public int Patch { get; private set; }
        public DevSpaceConfigFamily Family { get; private set; }

        private DevSpaceVersion() { }

        public static DevSpaceVersion Parse(string text)
        {
            var match = VersionRegex.Match(text ?? string.Empty);
            if (!match.Success)
            {
                throw new FormatException("无法识别 DevSpace 版本：" + (text ?? string.Empty));
            }

            var major = int.Parse(match.Groups[1].Value);
            var minor = int.Parse(match.Groups[2].Value);
            var patch = int.Parse(match.Groups[3].Value);

            DevSpaceConfigFamily family;
            if (major == 1 && minor == 0)
            {
                family = DevSpaceConfigFamily.Legacy10;
            }
            else if (major == 1 && minor == 1)
            {
                family = DevSpaceConfigFamily.Modern11;
            }
            else
            {
                throw new NotSupportedException(
                    "当前控制平台只验证了 DevSpace 1.0.x 和 1.1.x；检测到 " +
                    major + "." + minor + "." + patch + "，已拒绝猜测兼容性。");
            }

            return new DevSpaceVersion
            {
                Raw = text.Trim(),
                Major = major,
                Minor = minor,
                Patch = patch,
                Family = family
            };
        }

        public static DevSpaceVersion FromPackageJson(string packageJsonPath)
        {
            if (string.IsNullOrWhiteSpace(packageJsonPath) || !File.Exists(packageJsonPath))
            {
                throw new FileNotFoundException("找不到 DevSpace package.json。", packageJsonPath);
            }

            var serializer = new JavaScriptSerializer();
            var value = serializer.DeserializeObject(File.ReadAllText(packageJsonPath, Encoding.UTF8))
                as Dictionary<string, object>;
            object version;
            if (value == null || !value.TryGetValue("version", out version) || version == null)
            {
                throw new InvalidDataException("DevSpace package.json 缺少 version。");
            }
            return Parse(Convert.ToString(version));
        }

        public override string ToString()
        {
            return Major + "." + Minor + "." + Patch;
        }
    }

    internal sealed class ManagedDevSpaceSettings
    {
        public List<string> AllowedRoots { get; set; }
        public string Host { get; set; }
        public int LocalPort { get; set; }
        public string PublicBaseUrl { get; set; }
        public string ToolMode { get; set; }
        public bool ReviewUiEnabled { get; set; }
        public bool SkillsEnabled { get; set; }
        public List<string> SkillPaths { get; set; }
        public string AgentDir { get; set; }
        public string StateDir { get; set; }
        public string WorktreeRoot { get; set; }
        public bool TrustProxy { get; set; }
        public string LogLevel { get; set; }
        public string LogFormat { get; set; }
        public bool LogRequests { get; set; }
        public bool LogToolCalls { get; set; }
        public bool LogShellCommands { get; set; }

        public static ManagedDevSpaceSettings CreateDefault(string platformRoot)
        {
            var stateRoot = Path.Combine(platformRoot, "state");
            return new ManagedDevSpaceSettings
            {
                AllowedRoots = new List<string> { platformRoot },
                Host = "127.0.0.1",
                LocalPort = 7676,
                PublicBaseUrl = null,
                ToolMode = "codex",
                ReviewUiEnabled = true,
                SkillsEnabled = true,
                SkillPaths = new List<string>(),
                AgentDir = Path.Combine(stateRoot, "agent-home"),
                StateDir = Path.Combine(stateRoot, "devspace-state"),
                WorktreeRoot = Path.Combine(stateRoot, "worktrees"),
                TrustProxy = false,
                LogLevel = "info",
                LogFormat = "pretty",
                LogRequests = true,
                LogToolCalls = true,
                LogShellCommands = false
            };
        }
    }

    internal sealed class DevSpaceLaunchPlan
    {
        public DevSpaceVersion Version { get; set; }
        public string ConfigDirectory { get; set; }
        public string ConfigPath { get; set; }
        public string SerializedConfig { get; set; }
        public Dictionary<string, string> EnvironmentVariables { get; set; }
    }

    internal static class DevSpaceConfiguration
    {
        private const string ConfigSchemaUrl =
            "https://raw.githubusercontent.com/Waishnav/devspace/main/schema/v1/devspace.schema.json";

        public static DevSpaceLaunchPlan BuildPlan(
            DevSpaceVersion version,
            ManagedDevSpaceSettings settings,
            string configDirectory)
        {
            if (version == null) throw new ArgumentNullException("version");
            if (settings == null) throw new ArgumentNullException("settings");
            if (string.IsNullOrWhiteSpace(configDirectory))
            {
                throw new ArgumentException("DevSpace managed config directory 不能为空。", "configDirectory");
            }

            ValidateSettings(version, settings);

            var serializer = new JavaScriptSerializer();
            var normalizedConfigDirectory = Path.GetFullPath(configDirectory);
            var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                { "DEVSPACE_CONFIG_DIR", normalizedConfigDirectory },
                { "DEVSPACE_COMPACT_RUN_ROOT", Path.Combine(Path.GetFullPath(settings.StateDir), "compact-runs") },
                { "DEVSPACE_COMPACT_LOG_RETENTION_DAYS", "30" },
                { "DEVSPACE_COMPACT_LOG_MAX_BYTES", (2L * 1024 * 1024 * 1024).ToString() }
            };

            object config;
            string fileName;
            if (version.Family == DevSpaceConfigFamily.Legacy10)
            {
                fileName = "config.json";
                config = BuildLegacyConfig(settings);
                AddLegacyEnvironment(environment, settings);
            }
            else
            {
                fileName = "config.jsonc";
                config = BuildModernConfig(settings);
            }

            return new DevSpaceLaunchPlan
            {
                Version = version,
                ConfigDirectory = normalizedConfigDirectory,
                ConfigPath = Path.Combine(normalizedConfigDirectory, fileName),
                SerializedConfig = serializer.Serialize(config),
                EnvironmentVariables = environment
            };
        }

        public static void WritePlan(DevSpaceLaunchPlan plan)
        {
            if (plan == null) throw new ArgumentNullException("plan");
            Directory.CreateDirectory(plan.ConfigDirectory);

            var temporaryPath = plan.ConfigPath + ".tmp";
            File.WriteAllText(
                temporaryPath,
                plan.SerializedConfig + Environment.NewLine,
                new UTF8Encoding(false));

            if (File.Exists(plan.ConfigPath))
            {
                File.Replace(temporaryPath, plan.ConfigPath, null, true);
            }
            else
            {
                File.Move(temporaryPath, plan.ConfigPath);
            }
        }

        private static void ValidateSettings(DevSpaceVersion version, ManagedDevSpaceSettings settings)
        {
            if (settings.AllowedRoots == null || settings.AllowedRoots.Count == 0)
            {
                throw new InvalidDataException("至少需要一个 DevSpace allowed root。");
            }

            foreach (var root in settings.AllowedRoots)
            {
                if (string.IsNullOrWhiteSpace(root))
                {
                    throw new InvalidDataException("Allowed root 不能为空。");
                }
            }

            if (settings.LocalPort < 1 || settings.LocalPort > 65535)
            {
                throw new InvalidDataException("本地端口必须在 1 到 65535 之间。");
            }

            if (version.Family == DevSpaceConfigFamily.Legacy10)
            {
                if (!EqualsAny(settings.ToolMode, "minimal", "full", "codex"))
                {
                    throw new InvalidDataException("DevSpace 1.0.x Tool mode 必须是 minimal、full 或 codex。");
                }
            }
            else if (!EqualsAny(settings.ToolMode, "codex", "claude"))
            {
                throw new InvalidDataException("DevSpace 1.1.x Tool mode 必须是 codex 或 claude。");
            }

            if (!EqualsAny(settings.LogLevel, "silent", "error", "warn", "info", "debug"))
            {
                throw new InvalidDataException("Log level 无效。");
            }
            if (!EqualsAny(settings.LogFormat, "json", "pretty"))
            {
                throw new InvalidDataException("Log format 必须是 json 或 pretty。");
            }
        }

        private static Dictionary<string, object> BuildLegacyConfig(ManagedDevSpaceSettings settings)
        {
            return new Dictionary<string, object>
            {
                { "host", settings.Host },
                { "port", settings.LocalPort },
                { "allowedRoots", NormalizePaths(settings.AllowedRoots) },
                { "publicBaseUrl", NullIfBlank(settings.PublicBaseUrl) },
                { "allowedHosts", new string[0] },
                { "stateDir", Path.GetFullPath(settings.StateDir) },
                { "worktreeRoot", Path.GetFullPath(settings.WorktreeRoot) },
                { "artifactsEnabled", false },
                { "artifactMaxFileBytes", 100 * 1024 * 1024 },
                { "agentDir", Path.GetFullPath(settings.AgentDir) },
                { "subagents", false }
            };
        }

        private static Dictionary<string, object> BuildModernConfig(ManagedDevSpaceSettings settings)
        {
            return new Dictionary<string, object>
            {
                { "$schema", ConfigSchemaUrl },
                { "configVersion", 1 },
                { "server", new Dictionary<string, object>
                    {
                        { "host", settings.Host },
                        { "port", settings.LocalPort },
                        { "publicBaseUrl", NullIfBlank(settings.PublicBaseUrl) },
                        { "allowedHosts", new string[0] },
                        { "trustProxy", settings.TrustProxy }
                    }
                },
                { "workspaces", new Dictionary<string, object>
                    {
                        { "allowedRoots", NormalizePaths(settings.AllowedRoots) },
                        { "worktreeRoot", Path.GetFullPath(settings.WorktreeRoot) }
                    }
                },
                { "storage", new Dictionary<string, object>
                    {
                        { "stateDir", Path.GetFullPath(settings.StateDir) }
                    }
                },
                { "tools", new Dictionary<string, object>
                    {
                        { "mode", settings.ToolMode.ToLowerInvariant() }
                    }
                },
                { "ui", new Dictionary<string, object>
                    {
                        { "enabled", settings.ReviewUiEnabled }
                    }
                },
                { "artifacts", new Dictionary<string, object>
                    {
                        { "enabled", false },
                        { "maxFileBytes", 100 * 1024 * 1024 }
                    }
                },
                { "skills", new Dictionary<string, object>
                    {
                        { "enabled", settings.SkillsEnabled },
                        { "paths", NormalizePaths(settings.SkillPaths ?? new List<string>()) },
                        { "agentDir", Path.GetFullPath(settings.AgentDir) }
                    }
                },
                { "subagents", new Dictionary<string, object>
                    {
                        { "enabled", false },
                        { "providers", new object[0] }
                    }
                },
                { "logging", new Dictionary<string, object>
                    {
                        { "level", settings.LogLevel.ToLowerInvariant() },
                        { "format", settings.LogFormat.ToLowerInvariant() },
                        { "requests", settings.LogRequests },
                        { "assets", false },
                        { "toolCalls", settings.LogToolCalls },
                        { "shellCommands", settings.LogShellCommands }
                    }
                },
                { "oauth", new Dictionary<string, object>
                    {
                        { "accessTokenTtlSeconds", 3600 },
                        { "refreshTokenTtlSeconds", 2592000 },
                        { "scopes", new[] { "devspace" } },
                        { "allowedRedirectHosts", new[] { "chatgpt.com", "localhost", "127.0.0.1" } }
                    }
                }
            };
        }

        private static void AddLegacyEnvironment(
            IDictionary<string, string> environment,
            ManagedDevSpaceSettings settings)
        {
            environment["DEVSPACE_SUBAGENTS"] = "0";
            environment["DEVSPACE_TOOL_MODE"] = settings.ToolMode.ToLowerInvariant();
            environment["DEVSPACE_WIDGETS"] = settings.ReviewUiEnabled ? "changes" : "off";
            environment["DEVSPACE_SKILLS"] = settings.SkillsEnabled ? "1" : "0";
            environment["DEVSPACE_TRUST_PROXY"] = settings.TrustProxy ? "1" : "0";
            environment["DEVSPACE_LOG_LEVEL"] = settings.LogLevel.ToLowerInvariant();
            environment["DEVSPACE_LOG_FORMAT"] = settings.LogFormat.ToLowerInvariant();
            environment["DEVSPACE_LOG_REQUESTS"] = settings.LogRequests ? "1" : "0";
            environment["DEVSPACE_LOG_TOOL_CALLS"] = settings.LogToolCalls ? "1" : "0";
            environment["DEVSPACE_LOG_SHELL_COMMANDS"] = settings.LogShellCommands ? "1" : "0";
        }

        private static string[] NormalizePaths(IEnumerable<string> paths)
        {
            var normalized = new List<string>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var path in paths)
            {
                if (string.IsNullOrWhiteSpace(path)) continue;
                var fullPath = Path.GetFullPath(path.Trim()).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                if (seen.Add(fullPath)) normalized.Add(fullPath);
            }
            return normalized.ToArray();
        }

        private static object NullIfBlank(string value)
        {
            return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
        }

        private static bool EqualsAny(string value, params string[] candidates)
        {
            foreach (var candidate in candidates)
            {
                if (string.Equals(value, candidate, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }
    }
}
