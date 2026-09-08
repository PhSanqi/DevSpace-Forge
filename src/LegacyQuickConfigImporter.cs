using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace DevSpaceControlPlatform
{
    internal sealed class LegacyQuickConfigSettings
    {
        public int SchemaVersion { get; set; }
        public string WorkspaceRoot { get; set; }
        public string ToolMode { get; set; }
        public int LocalPort { get; set; }
        public string TunnelMode { get; set; }
        public string FixedHostname { get; set; }
        public string NamedTunnelIdOrName { get; set; }
        public string CredentialsFilePath { get; set; }
        public string CloudflaredConfigPath { get; set; }
        public bool AutoStart { get; set; }
        public bool IsNamedTunnel { get; set; }
    }

    internal sealed class LegacyQuickConfigImportResult
    {
        public PlatformSettings Settings { get; set; }
        public List<string> Notes { get; set; }
    }

    internal static class LegacyQuickConfigImporter
    {
        public static LegacyQuickConfigImportResult Import(
            string legacySettingsPath,
            string platformRoot,
            DevSpaceVersion targetVersion)
        {
            if (string.IsNullOrWhiteSpace(legacySettingsPath) || !File.Exists(legacySettingsPath))
            {
                throw new FileNotFoundException("旧 QuickConfig settings.json 不存在。", legacySettingsPath);
            }

            var serializer = new JavaScriptSerializer();
            var legacy = serializer.Deserialize<LegacyQuickConfigSettings>(
                File.ReadAllText(legacySettingsPath, Encoding.UTF8));
            if (legacy == null || legacy.SchemaVersion != 1)
            {
                throw new InvalidDataException("旧 QuickConfig settings.json schema version 不受支持。");
            }

            var result = new LegacyQuickConfigImportResult
            {
                Settings = PlatformSettings.CreateDefault(platformRoot),
                Notes = new List<string>()
            };

            var next = result.Settings;
            next.AllowedRoots.Clear();
            if (!string.IsNullOrWhiteSpace(legacy.WorkspaceRoot))
            {
                next.AllowedRoots.Add(Path.GetFullPath(legacy.WorkspaceRoot.Trim()));
            }
            next.LocalPort = legacy.LocalPort <= 0 ? 7676 : legacy.LocalPort;
            next.TunnelMode = NormalizeTunnelMode(legacy);
            next.FixedHostname = legacy.FixedHostname ?? string.Empty;
            next.NamedTunnelIdOrName = legacy.NamedTunnelIdOrName ?? string.Empty;
            next.CredentialsFilePath = legacy.CredentialsFilePath ?? string.Empty;
            next.CloudflaredConfigPath = legacy.CloudflaredConfigPath ?? string.Empty;
            next.AutoStart = legacy.AutoStart;
            next.ToolMode = NormalizeToolMode(legacy.ToolMode, targetVersion, result.Notes);

            result.Notes.Add("旧 WorkspaceRoot 已迁移为 AllowedRoots 列表。 ");
            result.Notes.Add("Owner password、auth.json 和 credentials 文件内容未迁移；仅保留已有路径引用。 ");
            result.Notes.Add("Subagents 未从旧配置继承，继续强制关闭。 ");
            return result;
        }

        private static string NormalizeTunnelMode(LegacyQuickConfigSettings legacy)
        {
            if (string.Equals(legacy.TunnelMode, "Quick", StringComparison.OrdinalIgnoreCase)) return "Quick";
            if (string.Equals(legacy.TunnelMode, "Named", StringComparison.OrdinalIgnoreCase) || legacy.IsNamedTunnel) return "Named";
            return string.Empty;
        }

        private static string NormalizeToolMode(
            string legacyMode,
            DevSpaceVersion targetVersion,
            List<string> notes)
        {
            var mode = (legacyMode ?? "minimal").Trim().ToLowerInvariant();
            if (targetVersion != null && targetVersion.Family == DevSpaceConfigFamily.Modern11)
            {
                if (mode == "codex") return "codex";
                if (mode == "minimal" || mode == "full")
                {
                    notes.Add("旧 Tool mode " + mode + " 在 DevSpace 1.1 中不存在，已映射为 claude。 ");
                    return "claude";
                }
                throw new InvalidDataException("旧 Tool mode 无法迁移：" + mode);
            }

            if (mode == "minimal" || mode == "full" || mode == "codex") return mode;
            throw new InvalidDataException("旧 Tool mode 无法迁移：" + mode);
        }
    }
}
