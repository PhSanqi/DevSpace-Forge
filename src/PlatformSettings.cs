using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace DevSpaceControlPlatform
{
    internal sealed class PlatformSettings
    {
        public int SchemaVersion { get; set; }
        public List<string> AllowedRoots { get; set; }
        public List<string> AllowedHosts { get; set; }
        public int LocalPort { get; set; }
        public string TunnelMode { get; set; }
        public string FixedHostname { get; set; }
        public string NamedTunnelIdOrName { get; set; }
        public string CredentialsFilePath { get; set; }
        public string CloudflaredConfigPath { get; set; }
        public string CloudflaredProtocol { get; set; }
        public bool AutoStart { get; set; }
        public string ToolMode { get; set; }
        public bool ReviewUiEnabled { get; set; }
        public bool SkillsEnabled { get; set; }
        public List<string> SkillPaths { get; set; }
        public string LogLevel { get; set; }
        public string LogFormat { get; set; }
        public bool LogRequests { get; set; }
        public bool LogToolCalls { get; set; }
        public bool LogShellCommands { get; set; }

        public static PlatformSettings CreateDefault(string platformRoot)
        {
            return new PlatformSettings
            {
                SchemaVersion = 1,
                AllowedRoots = new List<string> { Path.GetFullPath(platformRoot) },
                AllowedHosts = new List<string>(),
                LocalPort = 7677,
                TunnelMode = "Remote",
                FixedHostname = string.Empty,
                NamedTunnelIdOrName = string.Empty,
                CredentialsFilePath = string.Empty,
                CloudflaredConfigPath = string.Empty,
                CloudflaredProtocol = "auto",
                AutoStart = false,
                ToolMode = "codex",
                ReviewUiEnabled = true,
                SkillsEnabled = true,
                SkillPaths = new List<string>(),
                LogLevel = "info",
                LogFormat = "pretty",
                LogRequests = true,
                LogToolCalls = true,
                LogShellCommands = false
            };
        }

        public PlatformSettings Clone()
        {
            return new PlatformSettings
            {
                SchemaVersion = SchemaVersion,
                AllowedRoots = new List<string>(AllowedRoots ?? new List<string>()),
                AllowedHosts = new List<string>(AllowedHosts ?? new List<string>()),
                LocalPort = LocalPort,
                TunnelMode = TunnelMode,
                FixedHostname = FixedHostname,
                NamedTunnelIdOrName = NamedTunnelIdOrName,
                CredentialsFilePath = CredentialsFilePath,
                CloudflaredConfigPath = CloudflaredConfigPath,
                CloudflaredProtocol = CloudflaredProtocol,
                AutoStart = AutoStart,
                ToolMode = ToolMode,
                ReviewUiEnabled = ReviewUiEnabled,
                SkillsEnabled = SkillsEnabled,
                SkillPaths = new List<string>(SkillPaths ?? new List<string>()),
                LogLevel = LogLevel,
                LogFormat = LogFormat,
                LogRequests = LogRequests,
                LogToolCalls = LogToolCalls,
                LogShellCommands = LogShellCommands
            };
        }

        public ManagedDevSpaceSettings ToManagedDevSpaceSettings(
            string platformRoot,
            string publicBaseUrl)
        {
            var stateRoot = Path.Combine(Path.GetFullPath(platformRoot), "state");
            return new ManagedDevSpaceSettings
            {
                AllowedRoots = new List<string>(AllowedRoots ?? new List<string>()),
                AllowedHosts = new List<string>(AllowedHosts ?? new List<string>()),
                Host = "127.0.0.1",
                LocalPort = LocalPort,
                PublicBaseUrl = string.IsNullOrWhiteSpace(publicBaseUrl) ? null : publicBaseUrl.Trim(),
                ToolMode = ToolMode,
                ReviewUiEnabled = ReviewUiEnabled,
                SkillsEnabled = SkillsEnabled,
                SkillPaths = new List<string>(SkillPaths ?? new List<string>()),
                AgentDir = Path.Combine(stateRoot, "agent-home"),
                StateDir = Path.Combine(stateRoot, "devspace-state"),
                WorktreeRoot = Path.Combine(stateRoot, "worktrees"),
                TrustProxy = false,
                LogLevel = LogLevel,
                LogFormat = LogFormat,
                LogRequests = LogRequests,
                LogToolCalls = LogToolCalls,
                LogShellCommands = LogShellCommands
            };
        }
    }

    internal static class PlatformSettingsStore
    {
        public static PlatformSettings Load(string path, string platformRoot)
        {
            if (!File.Exists(path)) return PlatformSettings.CreateDefault(platformRoot);
            var serializer = new JavaScriptSerializer();
            var settings = serializer.Deserialize<PlatformSettings>(File.ReadAllText(path, Encoding.UTF8));
            if (settings == null || settings.SchemaVersion != 1)
            {
                throw new InvalidDataException("settings.json schema version 不受支持。");
            }
            settings.AllowedRoots = settings.AllowedRoots ?? new List<string>();
            settings.AllowedHosts = settings.AllowedHosts ?? new List<string>();
            settings.SkillPaths = settings.SkillPaths ?? new List<string>();
            settings.CloudflaredProtocol = CloudflareTunnelProtocol.Normalize(settings.CloudflaredProtocol, "http2");
            return settings;
        }

        public static void Save(string path, PlatformSettings settings)
        {
            if (settings == null) throw new ArgumentNullException("settings");
            if (settings.SchemaVersion != 1) throw new InvalidDataException("settings.json schema version 不受支持。");
            settings.CloudflaredProtocol = CloudflareTunnelProtocol.Normalize(settings.CloudflaredProtocol, "auto");
            var serializer = new JavaScriptSerializer();
            AtomicWrite(path, serializer.Serialize(settings));
        }

        public static string Serialize(PlatformSettings settings)
        {
            if (settings == null) throw new ArgumentNullException("settings");
            return new JavaScriptSerializer().Serialize(settings);
        }

        public static PlatformSettings Deserialize(string text)
        {
            var settings = new JavaScriptSerializer().Deserialize<PlatformSettings>(text);
            if (settings == null || settings.SchemaVersion != 1)
            {
                throw new InvalidDataException("历史 settings schema version 不受支持。");
            }
            settings.AllowedRoots = settings.AllowedRoots ?? new List<string>();
            settings.AllowedHosts = settings.AllowedHosts ?? new List<string>();
            settings.SkillPaths = settings.SkillPaths ?? new List<string>();
            settings.CloudflaredProtocol = CloudflareTunnelProtocol.Normalize(settings.CloudflaredProtocol, "http2");
            return settings;
        }

        private static void AtomicWrite(string path, string text)
        {
            var directory = Path.GetDirectoryName(Path.GetFullPath(path));
            Directory.CreateDirectory(directory);
            var temporaryPath = path + ".tmp";
            File.WriteAllText(temporaryPath, text + Environment.NewLine, new UTF8Encoding(false));
            if (File.Exists(path)) File.Replace(temporaryPath, path, null, true);
            else File.Move(temporaryPath, path);
        }
    }

    internal static class CloudflareTunnelProtocol
    {
        public static string Normalize(string value, string fallback)
        {
            var normalized = string.IsNullOrWhiteSpace(value)
                ? (fallback ?? string.Empty).Trim().ToLowerInvariant()
                : value.Trim().ToLowerInvariant();
            if (normalized == "auto" || normalized == "quic" || normalized == "http2") return normalized;
            throw new InvalidDataException("cloudflared protocol 必须是 auto、quic 或 http2。");
        }

        public static string CommandArgument(string value, string fallback)
        {
            var protocol = Normalize(value, fallback);
            return protocol == "auto" ? string.Empty : " --protocol " + protocol;
        }
    }

    internal sealed class CloudflareTunnelLogEvent
    {
        public bool Registered { get; set; }
        public bool Terminated { get; set; }
        public bool IdleTimeout { get; set; }
        public bool TlsHandshakeError { get; set; }
        public bool QuicDialFailure { get; set; }
        public bool PrecheckFailure { get; set; }
        public string Protocol { get; set; }
        public int ConnectionIndex { get; set; }
    }

    internal static class CloudflareTunnelLogClassifier
    {
        public static CloudflareTunnelLogEvent Classify(string line)
        {
            var value = line ?? string.Empty;
            var protocolMatch = Regex.Match(value, @"protocol=([^\s]+)", RegexOptions.IgnoreCase);
            var connectionMatch = Regex.Match(value, @"connIndex=(\d+)", RegexOptions.IgnoreCase);
            int connectionIndex;
            if (!connectionMatch.Success || !int.TryParse(connectionMatch.Groups[1].Value, out connectionIndex))
                connectionIndex = -1;
            return new CloudflareTunnelLogEvent
            {
                Registered = value.IndexOf("registered tunnel connection", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    value.IndexOf("connection registered", StringComparison.OrdinalIgnoreCase) >= 0,
                Terminated = value.IndexOf("connection terminated", StringComparison.OrdinalIgnoreCase) >= 0,
                IdleTimeout = value.IndexOf("timeout: no recent network activity", StringComparison.OrdinalIgnoreCase) >= 0,
                TlsHandshakeError = value.IndexOf("TLS handshake with edge error", StringComparison.OrdinalIgnoreCase) >= 0,
                QuicDialFailure = value.IndexOf("Failed to dial a quic connection", StringComparison.OrdinalIgnoreCase) >= 0,
                PrecheckFailure =
                    (value.IndexOf("precheck", StringComparison.OrdinalIgnoreCase) >= 0 &&
                     value.IndexOf("status=fail", StringComparison.OrdinalIgnoreCase) >= 0) ||
                    value.IndexOf("HTTP/2 connection is blocked or unreachable", StringComparison.OrdinalIgnoreCase) >= 0,
                Protocol = protocolMatch.Success ? protocolMatch.Groups[1].Value.Trim() : string.Empty,
                ConnectionIndex = connectionIndex
            };
        }
    }

    internal static class PublicEndpoint
    {
        public static string NormalizeHostAndPath(string value)
        {
            var input = (value ?? string.Empty).Trim();
            if (input.Length == 0) return string.Empty;

            Uri uri;
            if (!input.Contains("://")) input = "https://" + input;
            if (!Uri.TryCreate(input, UriKind.Absolute, out uri) ||
                !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
                string.IsNullOrWhiteSpace(uri.Host))
            {
                throw new InvalidDataException("Cloudflare public endpoint 无效。请填写例如 dev.sanqi.org/group。");
            }
            if (!string.IsNullOrWhiteSpace(uri.Query) || !string.IsNullOrWhiteSpace(uri.Fragment))
                throw new InvalidDataException("Cloudflare public endpoint 不能包含 query 或 fragment。");

            var path = uri.AbsolutePath.Trim('/');
            if (path.EndsWith("/mcp", StringComparison.OrdinalIgnoreCase))
                path = path.Substring(0, path.Length - 4).TrimEnd('/');
            else if (string.Equals(path, "mcp", StringComparison.OrdinalIgnoreCase))
                path = string.Empty;

            return path.Length == 0 ? uri.Host : uri.Host + "/" + path;
        }

        public static string BaseUrl(string value)
        {
            var normalized = NormalizeHostAndPath(value);
            return normalized.Length == 0 ? string.Empty : "https://" + normalized;
        }

        public static string McpUrl(string value)
        {
            var baseUrl = BaseUrl(value);
            return baseUrl.Length == 0 ? string.Empty : baseUrl.TrimEnd('/') + "/mcp";
        }
    }

    internal static class ReadinessFormatter
    {
        public static string Format(
            bool devSpaceRunning,
            bool localReady,
            bool tunnelReady,
            bool publicConfigured,
            bool publicReady,
            bool realToolCallVerified,
            int publicMcpStatus,
            int publicAuthorizationMetadataStatus,
            int publicProtectedResourceMetadataStatus)
        {
            if (!devSpaceRunning) return "L0 DevSpace 未运行";
            if (!localReady) return "L1 本地 MCP/OAuth 未就绪";
            if (!publicConfigured) return "L2 本地已就绪；尚未配置公网入口";
            if (!tunnelReady) return "L2 本地已就绪；Tunnel 未就绪";
            if (!publicReady)
            {
                return "L3 公网路由未就绪（MCP " + StatusText(publicMcpStatus) +
                    " / OAuth " + StatusText(publicAuthorizationMetadataStatus) +
                    " / Resource " + StatusText(publicProtectedResourceMetadataStatus) + "）";
            }
            return realToolCallVerified
                ? "READY 公网 OAuth/MCP 已通过真实工具调用验证"
                : "L4 公网 OAuth/MCP 已就绪；等待一次真实工具调用完成最终验收";
        }

        private static string StatusText(int status)
        {
            return status <= 0 ? "ERR" : status.ToString();
        }
    }
}
