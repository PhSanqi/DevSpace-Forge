using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;

namespace DevSpaceControlPlatform
{
    internal sealed class ConfigurationSnapshot
    {
        public int SchemaVersion { get; set; }
        public string CreatedUtc { get; set; }
        public string DevSpaceVersion { get; set; }
        public string SettingsText { get; set; }
    }

    internal sealed class ConfigurationHistory
    {
        private readonly string historyDirectory;
        private readonly int maxSnapshots;

        public ConfigurationHistory(string historyDirectory, int maxSnapshots)
        {
            if (string.IsNullOrWhiteSpace(historyDirectory))
            {
                throw new ArgumentException("History directory 不能为空。", "historyDirectory");
            }
            if (maxSnapshots < 1) throw new ArgumentOutOfRangeException("maxSnapshots");
            this.historyDirectory = Path.GetFullPath(historyDirectory);
            this.maxSnapshots = maxSnapshots;
        }

        public string Snapshot(string settingsPath, DevSpaceVersion version)
        {
            if (string.IsNullOrWhiteSpace(settingsPath) || !File.Exists(settingsPath))
            {
                throw new FileNotFoundException("没有可保存到历史的控制平台 settings.json。", settingsPath);
            }

            Directory.CreateDirectory(historyDirectory);
            var snapshot = new ConfigurationSnapshot
            {
                SchemaVersion = 1,
                CreatedUtc = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                DevSpaceVersion = version == null ? "unknown" : version.ToString(),
                SettingsText = File.ReadAllText(settingsPath, Encoding.UTF8)
            };
            var serializer = new JavaScriptSerializer();
            var fileName = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff", CultureInfo.InvariantCulture) +
                "-" + Guid.NewGuid().ToString("N").Substring(0, 6) + ".json";
            var snapshotPath = Path.Combine(historyDirectory, fileName);
            AtomicWrite(snapshotPath, serializer.Serialize(snapshot));
            Trim();
            return snapshotPath;
        }

        public ConfigurationSnapshot Load(string snapshotPath)
        {
            var fullPath = Path.GetFullPath(snapshotPath ?? string.Empty);
            if (!IsSameOrInside(fullPath, historyDirectory))
            {
                throw new InvalidDataException("History snapshot 位于 managed history 目录之外。");
            }
            if (!File.Exists(fullPath)) throw new FileNotFoundException("History snapshot 不存在。", fullPath);

            var serializer = new JavaScriptSerializer();
            var snapshot = serializer.Deserialize<ConfigurationSnapshot>(
                File.ReadAllText(fullPath, Encoding.UTF8));
            if (snapshot == null || snapshot.SchemaVersion != 1 || snapshot.SettingsText == null)
            {
                throw new InvalidDataException("History snapshot 格式无效。");
            }
            PlatformSettingsStore.Deserialize(snapshot.SettingsText);
            return snapshot;
        }

        public List<string> ListNewestFirst()
        {
            if (!Directory.Exists(historyDirectory)) return new List<string>();
            return Directory.GetFiles(historyDirectory, "*.json")
                .OrderByDescending(File.GetLastWriteTimeUtc)
                .ToList();
        }

        private void Trim()
        {
            var files = ListNewestFirst();
            for (var index = maxSnapshots; index < files.Count; index++)
            {
                File.Delete(files[index]);
            }
        }

        private static void AtomicWrite(string path, string text)
        {
            var temporaryPath = path + ".tmp";
            File.WriteAllText(temporaryPath, text + Environment.NewLine, new UTF8Encoding(false));
            if (File.Exists(path)) File.Replace(temporaryPath, path, null, true);
            else File.Move(temporaryPath, path);
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
