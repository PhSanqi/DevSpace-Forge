using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

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

    internal sealed class SetupConnectivityReport
    {
        public int LocalStatusCode { get; set; }
        public bool CloudflaredRunning { get; set; }
        public int PublicStatusCode { get; set; }
    }

    internal static class SetupInstaller
    {
        private const string ProductRegistryPath = @"Software\DevSpaceControlPlatform";

        public static string OfflinePayloadPath(string platformRoot)
        {
            return Path.Combine(Path.GetFullPath(platformRoot), "payload", "runtime.tar");
        }

        public static bool HasOfflinePayload(string platformRoot)
        {
            var path = OfflinePayloadPath(platformRoot);
            return File.Exists(path) && new FileInfo(path).Length > 0;
        }

        public static bool HasExistingConfiguration(string platformRoot)
        {
            var root = Path.GetFullPath(platformRoot);
            var settingsPath = Path.Combine(root, "settings.json");
            if (!File.Exists(settingsPath)) return false;
            try
            {
                PlatformSettingsStore.Load(settingsPath, root);
                return true;
            }
            catch
            {
                return false;
            }
        }

        public static string FindExistingInstallationRoot(string bundleRoot)
        {
            var releaseRoot = Path.GetFullPath(bundleRoot);
            if (HasExistingConfiguration(releaseRoot)) return releaseRoot;

            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(ProductRegistryPath))
                {
                    var remembered = key == null ? string.Empty : Convert.ToString(key.GetValue("InstallRoot"));
                    if (!string.IsNullOrWhiteSpace(remembered) && HasExistingConfiguration(remembered))
                        return Path.GetFullPath(remembered);
                }
            }
            catch
            {
            }

            foreach (var process in Process.GetProcessesByName("DevSpaceControlPlatform"))
            {
                try
                {
                    var module = process.MainModule;
                    var executable = module == null ? string.Empty : module.FileName;
                    if (string.IsNullOrWhiteSpace(executable)) continue;
                    var candidate = Path.GetDirectoryName(Path.GetFullPath(executable));
                    if (!string.IsNullOrWhiteSpace(candidate) && HasExistingConfiguration(candidate))
                        return candidate;
                }
                catch
                {
                }
                finally
                {
                    process.Dispose();
                }
            }

            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
                {
                    var command = key == null
                        ? string.Empty
                        : Convert.ToString(key.GetValue("DevSpaceControlPlatform"));
                    var executable = ExecutableFromCommand(command);
                    var candidate = string.IsNullOrWhiteSpace(executable)
                        ? string.Empty
                        : Path.GetDirectoryName(Path.GetFullPath(executable));
                    if (!string.IsNullOrWhiteSpace(candidate) && HasExistingConfiguration(candidate))
                        return candidate;
                }
            }
            catch
            {
            }

            try
            {
                var parent = Directory.GetParent(releaseRoot);
                if (parent != null)
                {
                    var candidates = new List<string>();
                    foreach (var directory in parent.GetDirectories("DevSpace*"))
                    {
                        var candidate = directory.FullName;
                        if (string.Equals(candidate, releaseRoot, StringComparison.OrdinalIgnoreCase)) continue;
                        if (HasExistingConfiguration(candidate)) candidates.Add(candidate);
                    }
                    if (candidates.Count == 1) return Path.GetFullPath(candidates[0]);
                }
            }
            catch
            {
            }

            return releaseRoot;
        }

        private static void RememberInstallationRoot(string platformRoot)
        {
            using (var key = Registry.CurrentUser.CreateSubKey(ProductRegistryPath))
            {
                if (key == null) throw new InvalidOperationException("无法保存 DevSpace 安装目录。");
                key.SetValue("InstallRoot", Path.GetFullPath(platformRoot), RegistryValueKind.String);
            }
        }

        public static void EnsureOfflinePayload(string platformRoot)
        {
            ApplyOfflinePayload(platformRoot, platformRoot, false);
        }

        private static void ApplyOfflinePayload(string bundleRoot, string targetRoot, bool force)
        {
            var sourceRoot = Path.GetFullPath(bundleRoot);
            var root = Path.GetFullPath(targetRoot);
            if (force)
            {
                if (!HasOfflinePayload(sourceRoot))
                    throw new FileNotFoundException("更新包缺少离线 Runtime payload。", OfflinePayloadPath(sourceRoot));
                ApplyOfflinePayloadUpgrade(sourceRoot, root);
                return;
            }

            if (!force)
            {
                try
                {
                    ValidateBundle(root);
                    return;
                }
                catch
                {
                    if (!HasOfflinePayload(sourceRoot)) throw;
                }
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
            ExtractOfflinePayload(sourceRoot, root);
            ValidateBundle(root);
        }

        private static void ApplyOfflinePayloadUpgrade(string sourceRoot, string targetRoot)
        {
            Directory.CreateDirectory(targetRoot);
            var runtime = Path.Combine(targetRoot, "runtime");
            var activePointer = Path.Combine(runtime, "active-slot.txt");
            var previousActiveSlot = File.Exists(activePointer)
                ? File.ReadAllText(activePointer, Encoding.ASCII)
                : null;
            var cloudflared = Path.Combine(targetRoot, "cloudflared.exe");
            var cloudflaredBackup = cloudflared + ".update-backup";

            if (File.Exists(cloudflared))
                File.Copy(cloudflared, cloudflaredBackup, true);
            else if (File.Exists(cloudflaredBackup))
                File.Delete(cloudflaredBackup);

            try
            {
                ExtractOfflinePayload(sourceRoot, targetRoot);
                ValidateBundle(targetRoot);
                if (File.Exists(cloudflaredBackup)) File.Delete(cloudflaredBackup);
            }
            catch
            {
                try
                {
                    Directory.CreateDirectory(runtime);
                    if (previousActiveSlot == null)
                    {
                        if (File.Exists(activePointer)) File.Delete(activePointer);
                    }
                    else
                    {
                        File.WriteAllText(activePointer, previousActiveSlot, Encoding.ASCII);
                    }
                    if (File.Exists(cloudflaredBackup))
                        File.Copy(cloudflaredBackup, cloudflared, true);
                }
                catch
                {
                }
                throw;
            }
            finally
            {
                try
                {
                    if (File.Exists(cloudflaredBackup)) File.Delete(cloudflaredBackup);
                }
                catch
                {
                }
            }
        }

        private static void ExtractOfflinePayload(string sourceRoot, string targetRoot)
        {
            var systemTar = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "tar.exe");
            var tar = File.Exists(systemTar) ? systemTar : "tar.exe";
            var startInfo = new ProcessStartInfo
            {
                FileName = tar,
                Arguments = "-xf " + Quote(OfflinePayloadPath(sourceRoot)) + " -C " + Quote(targetRoot),
                WorkingDirectory = targetRoot,
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
        }

        public static string NormalizeHostname(string value)
        {
            return PublicEndpoint.NormalizeHostAndPath(value);
        }

        public static string NormalizeOriginHostname(string value)
        {
            var normalized = PublicEndpoint.NormalizeHostAndPath(value);
            if (normalized.Length == 0) return string.Empty;
            if (normalized.IndexOf('/') >= 0)
                throw new InvalidDataException("Cloudflare Tunnel origin hostname 只能填写域名，不能包含路径。");
            return normalized;
        }

        public static string ResolvePublicEndpoint(string originHostname, string publicEndpoint)
        {
            var origin = NormalizeOriginHostname(originHostname);
            if (origin.Length == 0)
                throw new InvalidDataException("请填写 Cloudflare Tunnel origin hostname。");
            return string.IsNullOrWhiteSpace(publicEndpoint)
                ? origin
                : NormalizeHostname(publicEndpoint);
        }

        public static string ConfigureRemoteEndpoints(
            PlatformSettings settings,
            string originHostname,
            string publicEndpoint)
        {
            if (settings == null) throw new ArgumentNullException("settings");
            var origin = NormalizeOriginHostname(originHostname);
            if (origin.Length == 0)
                throw new InvalidDataException("请填写 Cloudflare Tunnel origin hostname。");
            var endpoint = ResolvePublicEndpoint(origin, publicEndpoint);
            if (endpoint.Length == 0)
                throw new InvalidDataException("统一公网 endpoint 无效。");
            settings.AllowedHosts = new List<string> { origin };
            settings.FixedHostname = endpoint;
            return endpoint;
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

        public static string LocalMcpUrl(int port, string publicEndpoint)
        {
            var normalized = NormalizeHostname(publicEndpoint);
            var separator = normalized.IndexOf('/');
            var path = separator < 0 ? string.Empty : normalized.Substring(separator);
            return LocalOrigin(port) + path + "/mcp";
        }

        public static string PublicMcpUrl(string hostname)
        {
            return PublicEndpoint.McpUrl(hostname);
        }

        public static string WindowsAutoStartCommand(string platformRoot)
        {
            return Quote(Path.Combine(Path.GetFullPath(platformRoot), "DevSpaceControlPlatform.exe"));
        }

        public static void ApplyWindowsAutoStart(string platformRoot, bool enabled)
        {
            using (var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
            {
                if (key == null) throw new InvalidOperationException("无法打开 Windows 当前用户启动项。\n请检查当前用户注册表权限。");
                if (enabled)
                {
                    var executable = Path.Combine(Path.GetFullPath(platformRoot), "DevSpaceControlPlatform.exe");
                    if (!File.Exists(executable)) throw new FileNotFoundException("找不到 DevSpace Control 主程序。", executable);
                    key.SetValue("DevSpaceControlPlatform", Quote(executable), RegistryValueKind.String);
                }
                else
                {
                    key.DeleteValue("DevSpaceControlPlatform", false);
                }
            }
        }

        public static bool IsAcceptableEndpointStatus(int statusCode)
        {
            // 3xx/401/403/405 are valid for a reachable MCP endpoint (for example
            // Cloudflare Access or an unauthenticated MCP probe). 404 means we
            // reached the wrong route, while 5xx usually means Tunnel/origin failure.
            return statusCode >= 200 && statusCode < 500 && statusCode != 404;
        }

        public static SetupConnectivityReport WaitForConnectivity(
            string platformRoot,
            int port,
            string hostname,
            int timeoutSeconds)
        {
            var root = Path.GetFullPath(platformRoot);
            ValidatePort(port);
            var normalizedHostname = NormalizeHostname(hostname);
            if (normalizedHostname.Length == 0) throw new InvalidDataException("Cloudflare public hostname 不能为空。");
            if (timeoutSeconds < 1) throw new ArgumentOutOfRangeException("timeoutSeconds");

            var localUrl = LocalMcpUrl(port, normalizedHostname);
            var publicUrl = PublicMcpUrl(normalizedHostname);
            var cloudflaredPath = RuntimeResolver.ResolveCloudflaredPath(root);
            var deadline = DateTime.UtcNow.AddSeconds(timeoutSeconds);
            var localStatus = 0;
            var publicStatus = 0;
            var cloudflaredRunning = false;

            while (DateTime.UtcNow < deadline)
            {
                localStatus = ProbeHttpStatus(localUrl, 1800, true);
                cloudflaredRunning = IsExpectedProcessRunning(cloudflaredPath);
                publicStatus = ProbeHttpStatus(publicUrl, 2800, false);
                if (IsAcceptableEndpointStatus(localStatus) &&
                    cloudflaredRunning &&
                    IsAcceptableEndpointStatus(publicStatus))
                {
                    return new SetupConnectivityReport
                    {
                        LocalStatusCode = localStatus,
                        CloudflaredRunning = true,
                        PublicStatusCode = publicStatus
                    };
                }
                Thread.Sleep(1000);
            }

            var failures = new List<string>();
            if (!IsAcceptableEndpointStatus(localStatus))
                failures.Add("本地 DevSpace 未就绪（" + localUrl + "，HTTP " + DisplayStatus(localStatus) + "）");
            if (!cloudflaredRunning)
                failures.Add("当前安装目录的 cloudflared 未运行");
            if (!IsAcceptableEndpointStatus(publicStatus))
                failures.Add("公网 MCP 未连通（" + publicUrl + "，HTTP " + DisplayStatus(publicStatus) + "）");
            throw new InvalidOperationException(
                "安装配置已经写入，但连通性验收未通过：\r\n- " +
                string.Join("\r\n- ", failures.ToArray()) +
                "\r\n\r\n请确认 Cloudflare Public Hostname 指向该 Remote Tunnel，随后在 Control 中执行“重新启动全部”。");
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
            string originHostname,
            string publicEndpoint,
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
            var normalizedOriginHostname = NormalizeOriginHostname(originHostname);
            if (normalizedOriginHostname.Length == 0)
                throw new InvalidDataException("请填写 Cloudflare Tunnel origin hostname。");

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
            var normalizedPublicEndpoint = ConfigureRemoteEndpoints(
                settings,
                normalizedOriginHostname,
                publicEndpoint);
            settings.AutoStart = autoStart;
            settings.ToolMode = "codex";
            settings.ReviewUiEnabled = true;
            settings.SkillsEnabled = true;
            settings.LogLevel = string.IsNullOrWhiteSpace(settings.LogLevel) ? "info" : settings.LogLevel;
            settings.LogFormat = string.IsNullOrWhiteSpace(settings.LogFormat) ? "pretty" : settings.LogFormat;
            settings.LogRequests = true;
            settings.LogToolCalls = true;
            settings.LogShellCommands = false;
            settings.CloudflaredProtocol = "auto";
            PlatformSettingsStore.Save(settingsPath, settings);

            if (token.Length > 0) CloudflareTunnelSecretStore.SaveToken(root, token);
            ApplyWindowsAutoStart(root, autoStart);

            var result = FinalizeConfiguration(root, settings, versionText, false);
            RememberInstallationRoot(root);
            return result;
        }

        public static SetupInstallResult UpdateExisting(string bundleRoot, string platformRoot)
        {
            return UpdateExisting(bundleRoot, platformRoot, true);
        }

        internal static SetupInstallResult UpdateExisting(
            string bundleRoot,
            string platformRoot,
            bool applySystemIntegration)
        {
            var root = Path.GetFullPath(platformRoot);
            var sourceRoot = Path.GetFullPath(bundleRoot);
            var settingsPath = Path.Combine(root, "settings.json");
            if (!File.Exists(settingsPath))
                throw new FileNotFoundException("未找到现有 settings.json，不能执行直接更新。", settingsPath);

            var settings = PlatformSettingsStore.Load(settingsPath, root);
            if (string.Equals(settings.TunnelMode, "Remote", StringComparison.OrdinalIgnoreCase) &&
                !CloudflareTunnelSecretStore.HasToken(root))
            {
                throw new InvalidDataException("现有 Remote Tunnel 配置缺少本地 Token，无法无交互更新。");
            }

            StopManagedRuntimeProcesses(root);
            ApplyOfflinePayload(sourceRoot, root, true);
            CopyProductFiles(sourceRoot, root);
            var versionText = ValidateBundle(root);

            // Previous releases could persist http2 as the compatibility fallback.
            // Auto lets cloudflared select QUIC or HTTP/2 according to the current
            // network instead of pinning every restart to TCP/7844.
            settings.CloudflaredProtocol = "auto";
            PlatformSettingsStore.Save(settingsPath, settings);
            if (applySystemIntegration) ApplyWindowsAutoStart(root, settings.AutoStart);

            var result = FinalizeConfiguration(root, settings, versionText, true);
            if (applySystemIntegration) RememberInstallationRoot(root);
            return result;
        }

        private static void CopyProductFiles(string bundleRoot, string targetRoot)
        {
            var source = Path.GetFullPath(bundleRoot);
            var target = Path.GetFullPath(targetRoot);
            if (string.Equals(source, target, StringComparison.OrdinalIgnoreCase)) return;

            Directory.CreateDirectory(target);
            foreach (var fileName in new[]
            {
                "DevSpaceControlPlatform.exe",
                "Setup.exe",
                "README.md",
                "README.zh-CN.md",
                "LICENSE",
                "control-provenance.json",
                "update-control-platform-out-of-band.ps1"
            })
            {
                var from = Path.Combine(source, fileName);
                if (!File.Exists(from)) continue;
                File.Copy(from, Path.Combine(target, fileName), true);
            }

            var sourceOps = Path.Combine(source, "ops");
            var targetOps = Path.Combine(target, "ops");
            foreach (var fileName in new[]
            {
                "runtime-console.mjs",
                "runtime-console-ui.html",
                "runtime-console-ui.css",
                "runtime-console-ui.js",
                "start-runtime-console.ps1"
            })
            {
                var from = Path.Combine(sourceOps, fileName);
                if (!File.Exists(from)) continue;
                Directory.CreateDirectory(targetOps);
                File.Copy(from, Path.Combine(targetOps, fileName), true);
            }

            var sourcePayload = OfflinePayloadPath(source);
            if (File.Exists(sourcePayload))
            {
                var targetPayload = OfflinePayloadPath(target);
                Directory.CreateDirectory(Path.GetDirectoryName(targetPayload));
                File.Copy(sourcePayload, targetPayload, true);
            }
        }

        private static void StopManagedRuntimeProcesses(string platformRoot)
        {
            var root = Path.GetFullPath(platformRoot).TrimEnd(Path.DirectorySeparatorChar) +
                Path.DirectorySeparatorChar;
            foreach (var processName in new[] { "DevSpaceControlPlatform", "node", "cloudflared" })
            {
                foreach (var process in Process.GetProcessesByName(processName))
                {
                    try
                    {
                        var module = process.MainModule;
                        var executable = module == null ? string.Empty : module.FileName;
                        if (string.IsNullOrWhiteSpace(executable)) continue;
                        var fullPath = Path.GetFullPath(executable);
                        if (!fullPath.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;
                        if (process.Id == Process.GetCurrentProcess().Id) continue;
                        try
                        {
                            if (process.CloseMainWindow() && process.WaitForExit(2500)) continue;
                        }
                        catch { }
                        process.Kill();
                        process.WaitForExit(5000);
                    }
                    catch
                    {
                    }
                    finally
                    {
                        process.Dispose();
                    }
                }
            }
        }

        private static string ExecutableFromCommand(string command)
        {
            var value = (command ?? string.Empty).Trim();
            if (value.Length == 0) return string.Empty;
            if (value[0] == '"')
            {
                var end = value.IndexOf('"', 1);
                return end > 1 ? value.Substring(1, end - 1) : string.Empty;
            }
            var separator = value.IndexOf(' ');
            return separator < 0 ? value : value.Substring(0, separator);
        }

        private static SetupInstallResult FinalizeConfiguration(
            string root,
            PlatformSettings settings,
            string versionText,
            bool preserveExistingManagedConfig)
        {
            ValidatePort(settings.LocalPort);

            var packageRoot = RuntimeResolver.ResolveDevSpacePackageRoot(root);
            var version = DevSpaceVersion.FromPackageJson(Path.Combine(packageRoot, "package.json"));
            var normalizedPublicEndpoint = NormalizeHostname(settings.FixedHostname);
            var publicBaseUrl = normalizedPublicEndpoint.Length == 0
                ? null
                : PublicEndpoint.BaseUrl(normalizedPublicEndpoint);
            var configDirectory = Path.Combine(root, "state", "devspace-config");
            var plan = DevSpaceConfiguration.BuildPlan(
                version,
                settings.ToManagedDevSpaceSettings(root, publicBaseUrl),
                configDirectory);
            RuntimeResolver.AddRuntimeToolPaths(plan.EnvironmentVariables, root);
            var report = DevSpaceEffectiveStateVerifier.Verify(plan, root);
            if (!report.IsSafe)
                throw new InvalidDataException(string.Join(Environment.NewLine, report.Errors.ToArray()));
            if (!preserveExistingManagedConfig || !File.Exists(plan.ConfigPath))
                DevSpaceConfiguration.WritePlan(plan);
            ManagedAgentInstructions.Ensure(root);

            return new SetupInstallResult
            {
                LocalOrigin = LocalOrigin(settings.LocalPort),
                LocalMcpUrl = LocalMcpUrl(settings.LocalPort, normalizedPublicEndpoint),
                PublicMcpUrl = PublicMcpUrl(normalizedPublicEndpoint),
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

        private static int ProbeHttpStatus(string url, int timeoutMilliseconds, bool bypassProxy)
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(url);
                request.Method = "GET";
                request.AllowAutoRedirect = false;
                request.KeepAlive = false;
                request.Timeout = timeoutMilliseconds;
                request.ReadWriteTimeout = timeoutMilliseconds;
                request.UserAgent = "DevSpaceControlPlatform-Setup";
                if (bypassProxy) request.Proxy = null;
                try
                {
                    using (var response = (HttpWebResponse)request.GetResponse())
                        return (int)response.StatusCode;
                }
                catch (WebException exception)
                {
                    var response = exception.Response as HttpWebResponse;
                    if (response == null) return 0;
                    using (response) return (int)response.StatusCode;
                }
            }
            catch
            {
                return 0;
            }
        }

        private static bool IsExpectedProcessRunning(string expectedExecutable)
        {
            var expected = Path.GetFullPath(expectedExecutable);
            var processName = Path.GetFileNameWithoutExtension(expected);
            foreach (var process in Process.GetProcessesByName(processName))
            {
                try
                {
                    var module = process.MainModule;
                    var path = module == null ? string.Empty : module.FileName;
                    if (!string.IsNullOrWhiteSpace(path) &&
                        string.Equals(Path.GetFullPath(path), expected, StringComparison.OrdinalIgnoreCase))
                        return true;
                }
                catch
                {
                }
                finally
                {
                    process.Dispose();
                }
            }
            return false;
        }

        private static string DisplayStatus(int statusCode)
        {
            return statusCode > 0 ? statusCode.ToString() : "无响应";
        }

        private static string Quote(string value)
        {
            return "\"" + (value ?? string.Empty).Replace("\"", "\\\"") + "\"";
        }
    }
}
