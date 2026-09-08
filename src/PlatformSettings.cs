using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace DevSpaceControlPlatform
{
    internal sealed class PlatformSettings
    {
        public int SchemaVersion { get; set; }
        public List<string> AllowedRoots { get; set; }
        public int LocalPort { get; set; }
        public string TunnelMode { get; set; }
        public string FixedHostname { get; set; }
        public string NamedTunnelIdOrName { get; set; }
        public string CredentialsFilePath { get; set; }
        public string CloudflaredConfigPath { get; set; }
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
                LocalPort = 7677,
                TunnelMode = "Remote",
                FixedHostname = string.Empty,
                NamedTunnelIdOrName = string.Empty,
                CredentialsFilePath = string.Empty,
                CloudflaredConfigPath = string.Empty,
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
                LocalPort = LocalPort,
                TunnelMode = TunnelMode,
                FixedHostname = FixedHostname,
                NamedTunnelIdOrName = NamedTunnelIdOrName,
                CredentialsFilePath = CredentialsFilePath,
                CloudflaredConfigPath = CloudflaredConfigPath,
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
                TrustProxy = !string.IsNullOrWhiteSpace(publicBaseUrl),
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
            settings.SkillPaths = settings.SkillPaths ?? new List<string>();
            return settings;
        }

        public static void Save(string path, PlatformSettings settings)
        {
            if (settings == null) throw new ArgumentNullException("settings");
            if (settings.SchemaVersion != 1) throw new InvalidDataException("settings.json schema version 不受支持。");
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
            settings.SkillPaths = settings.SkillPaths ?? new List<string>();
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
}
