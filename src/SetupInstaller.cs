using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace DevSpaceControlPlatform
{
    internal sealed class SetupInstallResult
    {
        public string LocalOrigin { get; set; }
        public string LocalMcpUrl { get; set; }
        public string PublicMcpUrl { get; set; }
        public string OwnerPassword { get; set; }
        public string DevSpaceVersion { get; set; }
    }

    internal static class SetupInstaller
    {
        public static string OfflinePayloadPath(string platformRoot)
        {
            return Path.Combine(Path.GetFullPath(platformRoot), "payload", "runtime.tar");
        }

        public static bool HasOfflinePayload(string platformRoot)
        {
            var path = OfflinePayloadPath(platformRoot);
            return File.Exists(path) && new FileInfo(path).Length > 0;
        }

        public static void EnsureOfflinePayload(string platformRoot)
        {
            var root = Path.GetFullPath(platformRoot);
            try
            {
                ValidateBundle(root);
                return;
            }
            catch
            {
                if (!HasOfflinePayload(root)) throw;
            }

            try
            {
                var runtime = Path.Combine(root, "runtime");
                if (Directory.Exists(runtime)) Directory.Delete(runtime, true);
                var cloudflared = Path.Combine(root, "cloudflared.exe");
                if (File.Exists(cloudflared)) File.Delete(cloudflared);
            }
            catch (Exception exception)
            {
                throw new IOException("无法替换旧 Runtime。请先退出正在运行的 DevSpace Control，再重新运行 Setup。", exception);
            }

            var systemTar = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "tar.exe");
            var tar = File.Exists(systemTar) ? systemTar : "tar.exe";
            var startInfo = new ProcessStartInfo
            {
                FileName = tar,
                Arguments = "-xf " + Quote(OfflinePayloadPath(root)) + " -C " + Quote(root),
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using (var process = Process.Start(startInfo))
            {
                var stdout = process.StandardOutput.ReadToEnd();
                var stderr = process.StandardError.ReadToEnd();
                process.WaitForExit();
                if (process.ExitCode != 0)
                    throw new InvalidDataException("离线 Runtime 展开失败：" + stderr.Trim() + " " + stdout.Trim());
            }
            ValidateBundle(root);
        }

        public static string NormalizeHostname(string value)
        {
            var input = (value ?? string.Empty).Trim();
            if (input.Length == 0) return string.Empty;

            Uri uri;
            if (!input.Contains("://")) input = "https://" + input;
            if (!Uri.TryCreate(input, UriKind.Absolute, out uri) ||
                !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
                string.IsNullOrWhiteSpace(uri.Host))
            {
                throw new InvalidDataException("Cloudflare hostname 无效。请填写例如 devspace.example.com。\n不要填写 Tunnel 名称；Remote Tunnel 实际运行只需要公网 hostname 和 token。");
            }

            if (!string.IsNullOrWhiteSpace(uri.Query) || !string.IsNullOrWhiteSpace(uri.Fragment))
                throw new InvalidDataException("Cloudflare hostname 不能包含 query 或 fragment。");
            var path = uri.AbsolutePath.Trim('/');
            if (path.Length > 0 && !string.Equals(path, "mcp", StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Cloudflare hostname 只填写域名；可以粘贴完整的 https://.../mcp 地址，但不能包含其它路径。");
            return uri.Host;
        }

        public static string LocalOrigin(int port)
        {
            ValidatePort(port);
            return "http://127.0.0.1:" + port;
        }

        public static string LocalMcpUrl(int port)
        {
            return LocalOrigin(port) + "/mcp";
        }

        public static string PublicMcpUrl(string hostname)
        {
            var normalized = NormalizeHostname(hostname);
            return normalized.Length == 0 ? string.Empty : "https://" + normalized + "/mcp";
        }

        public static string ValidateBundle(string platformRoot)
        {
            var root = Path.GetFullPath(platformRoot);
            var node = RuntimeResolver.ResolveNodePath(root);
            var packageRoot = RuntimeResolver.ResolveDevSpacePackageRoot(root);
            var cloudflared = RuntimeResolver.ResolveCloudflaredPath(root);
            if (!File.Exists(node)) throw new FileNotFoundException("离线包缺少 Node.js。", node);
            if (!File.Exists(cloudflared)) throw new FileNotFoundException("离线包缺少 cloudflared。", cloudflared);
            var version = DevSpaceVersion.FromPackageJson(Path.Combine(packageRoot, "package.json"));
            return version.Raw;
        }

        public static SetupInstallResult Configure(
            string platformRoot,
            string allowedRoot,
            int port,
            string tunnelName,
            string hostname,
            string tunnelToken,
            bool autoStart)
        {
            var root = Path.GetFullPath(platformRoot);
            EnsureOfflinePayload(root);
            var versionText = ValidateBundle(root);
            ValidatePort(port);

            if (string.IsNullOrWhiteSpace(allowedRoot) || !Directory.Exists(allowedRoot))
                throw new DirectoryNotFoundException("Allowed Root 不存在：" + allowedRoot);
            var normalizedAllowedRoot = Path.GetFullPath(allowedRoot);
            var normalizedHostname = NormalizeHostname(hostname);
            if (normalizedHostname.Length == 0)
                throw new InvalidDataException("请填写 Cloudflare public hostname。");

            var token = (tunnelToken ?? string.Empty).Trim();
            if (token.Length == 0 && !CloudflareTunnelSecretStore.HasToken(root))
                throw new InvalidDataException("请填写 Cloudflare Remote Tunnel token。");

            var settingsPath = Path.Combine(root, "settings.json");
            PlatformSettings settings;
            try { settings = PlatformSettingsStore.Load(settingsPath, root); }
            catch { settings = PlatformSettings.CreateDefault(root); }
            settings.SchemaVersion = 1;
            settings.AllowedRoots = new List<string> { normalizedAllowedRoot };
            settings.LocalPort = port;
            settings.TunnelMode = "Remote";
            settings.NamedTunnelIdOrName = (tunnelName ?? string.Empty).Trim();
            settings.FixedHostname = normalizedHostname;
            settings.AutoStart = autoStart;
            settings.ToolMode = "codex";
            settings.ReviewUiEnabled = true;
            settings.SkillsEnabled = true;
            settings.LogLevel = string.IsNullOrWhiteSpace(settings.LogLevel) ? "info" : settings.LogLevel;
            settings.LogFormat = string.IsNullOrWhiteSpace(settings.LogFormat) ? "pretty" : settings.LogFormat;
            settings.LogRequests = true;
            settings.LogToolCalls = true;
            settings.LogShellCommands = false;
            PlatformSettingsStore.Save(settingsPath, settings);

            if (token.Length > 0) CloudflareTunnelSecretStore.SaveToken(root, token);

            var packageRoot = RuntimeResolver.ResolveDevSpacePackageRoot(root);
            var version = DevSpaceVersion.FromPackageJson(Path.Combine(packageRoot, "package.json"));
            var publicBaseUrl = "https://" + normalizedHostname;
            var configDirectory = Path.Combine(root, "state", "devspace-config");
            var plan = DevSpaceConfiguration.BuildPlan(
                version,
                settings.ToManagedDevSpaceSettings(root, publicBaseUrl),
                configDirectory);
            RuntimeResolver.AddRuntimeToolPaths(plan.EnvironmentVariables, root);
            var report = DevSpaceEffectiveStateVerifier.Verify(plan, root);
            if (!report.IsSafe)
                throw new InvalidDataException(string.Join(Environment.NewLine, report.Errors.ToArray()));
            DevSpaceConfiguration.WritePlan(plan);
            ManagedAgentInstructions.Ensure(root);

            return new SetupInstallResult
            {
                LocalOrigin = LocalOrigin(port),
                LocalMcpUrl = LocalMcpUrl(port),
                PublicMcpUrl = PublicMcpUrl(normalizedHostname),
                OwnerPassword = EnsureOwnerAuth(configDirectory),
                DevSpaceVersion = versionText
            };
        }

        private static string EnsureOwnerAuth(string configDirectory)
        {
            Directory.CreateDirectory(configDirectory);
            var path = Path.Combine(configDirectory, "auth.json");
            var serializer = new JavaScriptSerializer();
            Dictionary<string, object> auth = null;
            try
            {
                if (File.Exists(path))
                    auth = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
            }
            catch { }
            if (auth == null) auth = new Dictionary<string, object>();

            object existing;
            var owner = auth.TryGetValue("ownerToken", out existing) ? Convert.ToString(existing) : string.Empty;
            if (string.IsNullOrWhiteSpace(owner) || owner.Length < 16)
            {
                var bytes = new byte[32];
                using (var random = new RNGCryptoServiceProvider()) random.GetBytes(bytes);
                owner = Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
                auth["ownerToken"] = owner;
                var temp = path + ".tmp";
                File.WriteAllText(temp, serializer.Serialize(auth) + Environment.NewLine, new UTF8Encoding(false));
                if (File.Exists(path)) File.Replace(temp, path, null, true);
                else File.Move(temp, path);
            }
            CloudflareTunnelSecretStore.RestrictPrivateFile(path);
            return owner;
        }

        private static void ValidatePort(int port)
        {
            if (port < 1 || port > 65535)
                throw new InvalidDataException("本地端口必须在 1 到 65535 之间。");
        }

        private static string Quote(string value)
        {
            return "\"" + (value ?? string.Empty).Replace("\"", "\\\"") + "\"";
        }
    }
}
