using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace DevSpaceControlPlatform
{
    internal sealed class DevSpaceConversationInfo
    {
        public string WorkspaceId { get; set; }
        public string WorkspacePath { get; set; }
        public string ProjectName { get; set; }
        public string ConversationName { get; set; }
        public DateTime LastActivityUtc { get; set; }

        public override string ToString()
        {
            var project = string.IsNullOrWhiteSpace(ProjectName) && string.IsNullOrWhiteSpace(WorkspacePath)
                ? "未知项目"
                : string.IsNullOrWhiteSpace(ProjectName)
                    ? Path.GetFileName(WorkspacePath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
                    : ProjectName;
            var conversation = string.IsNullOrWhiteSpace(ConversationName) ? "GPT 标题待同步" : ConversationName;
            return project + " · " + conversation;
        }
    }

    internal sealed class ConversationDisplayMetadata
    {
        public string ProjectName { get; set; }
        public string ConversationName { get; set; }
    }

    internal sealed class ServiceSupervisor : IDisposable
    {
        private static readonly Regex QuickTunnelUrlRegex = new Regex(
            @"https://[a-z0-9-]+\.trycloudflare\.com",
            RegexOptions.Compiled | RegexOptions.IgnoreCase);

        private readonly object sync = new object();
        private readonly string platformRoot;
        private readonly string settingsPath;
        private readonly string configDirectory;
        private readonly string logsDirectory;
        private readonly string knownWorkspacesPath;
        private readonly string knownConversationsPath;
        private readonly string conversationMetadataPath;
        private readonly HashSet<string> knownWorkspacePaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private readonly ConversationLogStore conversationLogs;
        private Process devSpaceProcess;
        private Process cloudflareProcess;
        private ChildProcessJob processJob;
        private string devSpaceMessage = "已停止";
        private string cloudflareMessage = "已停止";
        private string dynamicPublicBaseUrl;
        private readonly Queue<string> recentServiceLogLines = new Queue<string>();
        private string latestToolCall = "尚无 DevSpace tool call";
        private string latestWorkspaceId = string.Empty;
        private string latestWorkspacePath = string.Empty;
        private string latestReviewedWorkspaceId = string.Empty;
        private readonly Dictionary<string, string> workspacePaths = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, string> conversationLatestTools = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, ConversationDisplayMetadata> conversationMetadata = new Dictionary<string, ConversationDisplayMetadata>(StringComparer.OrdinalIgnoreCase);
        private readonly HashSet<int> cloudflareConnections = new HashSet<int>();
        private string cloudflareProtocol = "unknown";
        private int cloudflareDisconnectCount;
        private int cloudflareNetworkTimeoutCount;
        private int cloudflareTlsHandshakeErrorCount;
        private int cloudflareQuicDialFailureCount;
        private int cloudflarePrecheckFailureCount;
        private bool devSpaceDesired;
        private bool cloudflareDesired;
        private bool devSpaceOriginHealthy;
        private DateTime devSpaceStartedUtc = DateTime.MinValue;
        private DateTime cloudflareStartedUtc = DateTime.MinValue;
        private DateTime lastRecoveryAttemptUtc = DateTime.MinValue;
        private DateTime lastDevSpaceHealthProbeUtc = DateTime.MinValue;
        private DateTime lastEndpointReadinessProbeUtc = DateTime.MinValue;
        private DateTime lastSuccessfulMcpToolCallUtc = DateTime.MinValue;
        private bool localEndpointReady;
        private bool publicEndpointReady;
        private bool publicEndpointConfigured;
        private string lastReadinessStatus = string.Empty;
        private int localMcpStatus;
        private int localAuthorizationMetadataStatus;
        private int localProtectedResourceMetadataStatus;
        private int publicMcpStatus;
        private int publicAuthorizationMetadataStatus;
        private int publicProtectedResourceMetadataStatus;
        private int consecutiveDevSpaceHealthFailures;
        private int connectivityCheckRunning;
        private bool disposing;

        public ServiceSupervisor(string platformRoot)
        {
            this.platformRoot = Path.GetFullPath(platformRoot);
            settingsPath = Path.Combine(this.platformRoot, "settings.json");
            configDirectory = Path.Combine(this.platformRoot, "state", "devspace-config");
            logsDirectory = Path.Combine(this.platformRoot, "logs");
            knownWorkspacesPath = Path.Combine(this.platformRoot, "state", "known-workspaces.txt");
            knownConversationsPath = Path.Combine(this.platformRoot, "state", "known-conversations.json");
            conversationMetadataPath = Path.Combine(this.platformRoot, "state", "conversation-metadata.json");
            conversationLogs = new ConversationLogStore(logsDirectory, 250);
            LoadKnownWorkspaces();
            LoadKnownConversations();
            LoadConversationMetadata();
            RecoverDevSpaceWorkspaceCatalog();
        }

        public string DevSpaceStatus
        {
            get
            {
                lock (sync)
                {
                    if (!IsAlive(devSpaceProcess)) return devSpaceMessage;
                    return (devSpaceOriginHealthy ? "本地端点健康 - " : "本地端点未就绪 - ") + devSpaceMessage;
                }
            }
        }

        public string CloudflareStatus
        {
            get
            {
                lock (sync)
                {
                    if (!IsAlive(cloudflareProcess)) return cloudflareMessage;
                    return (cloudflareConnections.Count > 0 ? "链路健康 - " : "正在连接 - ") + cloudflareMessage +
                        " · protocol=" + cloudflareProtocol +
                        " · reconnect=" + cloudflareDisconnectCount +
                        " · idle-timeout=" + cloudflareNetworkTimeoutCount +
                        " · tls-handshake=" + cloudflareTlsHandshakeErrorCount +
                        " · quic-dial=" + cloudflareQuicDialFailureCount +
                        " · precheck-fail=" + cloudflarePrecheckFailureCount;
                }
            }
        }

        public bool IsDevSpaceRunning
        {
            get { lock (sync) return IsAlive(devSpaceProcess); }
        }

        public bool IsCloudflareRunning
        {
            get { lock (sync) return IsAlive(cloudflareProcess); }
        }

        public bool IsDevSpaceHealthy
        {
            get { lock (sync) return IsAlive(devSpaceProcess) && devSpaceOriginHealthy; }
        }

        public bool IsCloudflareHealthy
        {
            get { lock (sync) return IsAlive(cloudflareProcess) && cloudflareConnections.Count > 0; }
        }

        public string ReadinessStatus
        {
            get
            {
                lock (sync)
                {
                    return ReadinessFormatter.Format(
                        IsAlive(devSpaceProcess),
                        localEndpointReady,
                        IsAlive(cloudflareProcess) && cloudflareConnections.Count > 0,
                        publicEndpointConfigured,
                        publicEndpointReady,
                        lastSuccessfulMcpToolCallUtc >= devSpaceStartedUtc && lastSuccessfulMcpToolCallUtc != DateTime.MinValue,
                        publicMcpStatus,
                        publicAuthorizationMetadataStatus,
                        publicProtectedResourceMetadataStatus);
                }
            }
        }

        public string McpUrl
        {
            get
            {
                var baseUrl = PublicBaseUrl(LoadSettings());
                return string.IsNullOrWhiteSpace(baseUrl) ? string.Empty : baseUrl.TrimEnd('/') + "/mcp";
            }
        }

        public string OwnerPassword
        {
            get
            {
                var path = Path.Combine(configDirectory, "auth.json");
                if (!File.Exists(path)) return string.Empty;
                try
                {
                    var auth = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(
                        File.ReadAllText(path, Encoding.UTF8));
                    object value;
                    return auth != null && auth.TryGetValue("ownerToken", out value)
                        ? Convert.ToString(value)
                        : string.Empty;
                }
                catch
                {
                    return string.Empty;
                }
            }
        }

        public string RecentServiceLogText
        {
            get
            {
                lock (sync) return string.Join(Environment.NewLine, recentServiceLogLines.ToArray());
            }
        }

        public DevSpaceConversationInfo[] KnownConversations
        {
            get
            {
                lock (sync)
                {
                    var ids = new HashSet<string>(workspacePaths.Keys, StringComparer.OrdinalIgnoreCase);
                    foreach (var id in conversationLogs.KnownWorkspaceIds) ids.Add(id);
                    return ids
                        .Select(id =>
                        {
                            string path;
                            workspacePaths.TryGetValue(id, out path);
                            ConversationDisplayMetadata metadata;
                            conversationMetadata.TryGetValue(id, out metadata);
                            return new DevSpaceConversationInfo
                            {
                                WorkspaceId = id,
                                WorkspacePath = path ?? string.Empty,
                                ProjectName = metadata == null ? string.Empty : metadata.ProjectName,
                                ConversationName = metadata == null ? string.Empty : metadata.ConversationName,
                                LastActivityUtc = conversationLogs.LastActivityUtc(id)
                            };
                        })
                        .OrderByDescending(v => v.LastActivityUtc)
                        .ThenBy(v => v.WorkspaceId, StringComparer.OrdinalIgnoreCase)
                        .ToArray();
                }
            }
        }

        public string ConversationLogText(string workspaceId)
        {
            return conversationLogs.ReadRecent(workspaceId);
        }

        public string ConversationLatestTool(string workspaceId)
        {
            lock (sync)
            {
                string tool;
                return !string.IsNullOrWhiteSpace(workspaceId) && conversationLatestTools.TryGetValue(workspaceId, out tool)
                    ? tool
                    : "尚无工具调用";
            }
        }

        public string ConversationDisplayName(string workspaceId)
        {
            if (string.IsNullOrWhiteSpace(workspaceId)) return "历史会话（标题不可用）";
            lock (sync)
            {
                ConversationDisplayMetadata metadata;
                return conversationMetadata.TryGetValue(workspaceId, out metadata) && !string.IsNullOrWhiteSpace(metadata.ConversationName)
                    ? metadata.ConversationName
                    : "GPT 标题待同步";
            }
        }

        public string LatestToolCall
        {
            get { lock (sync) return latestToolCall; }
        }

        public string LatestWorkspaceId
        {
            get { lock (sync) return latestWorkspaceId; }
        }

        public string LatestWorkspacePath
        {
            get { lock (sync) return latestWorkspacePath; }
        }

        public string LatestReviewedWorkspaceId
        {
            get { lock (sync) return latestReviewedWorkspaceId; }
        }

        public string LatestReviewedWorkspacePath
        {
            get
            {
                lock (sync)
                {
                    string path;
                    return !string.IsNullOrWhiteSpace(latestReviewedWorkspaceId) && workspacePaths.TryGetValue(latestReviewedWorkspaceId, out path)
                        ? path
                        : string.Empty;
                }
            }
        }

        public string[] KnownWorkspacePaths
        {
            get
            {
                lock (sync)
                {
                    var resolved = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    foreach (var path in knownWorkspacePaths.Where(Directory.Exists))
                    {
                        string repositoryRoot;
                        resolved.Add(DevSpaceReviewRollback.TryRepositoryRoot(path, out repositoryRoot)
                            ? repositoryRoot
                            : Path.GetFullPath(path));
                    }
                    return resolved.OrderBy(v => v, StringComparer.OrdinalIgnoreCase).ToArray();
                }
            }
        }

        public void ClearLatestReviewedWorkspace()
        {
            lock (sync) latestReviewedWorkspaceId = string.Empty;
        }

        public void StartAll()
        {
            var settings = LoadSettings();
            if (string.Equals(settings.TunnelMode, "Quick", StringComparison.OrdinalIgnoreCase))
            {
                StartCloudflare();
                return;
            }
            StartDevSpace();
            StartCloudflare();
        }

        public void StopAll()
        {
            StopCloudflare();
            StopDevSpace();
        }

        public void RestartAll()
        {
            StopAll();
            StartAll();
        }

        public void StartDevSpace()
        {
            StartDevSpaceWithPublicBaseUrl(null);
        }

        private void StartDevSpaceWithPublicBaseUrl(string publicBaseUrlOverride)
        {
            lock (sync) if (IsAlive(devSpaceProcess)) return;

            var settings = LoadSettings();
            var publicBaseUrl = publicBaseUrlOverride ?? PublicBaseUrl(settings);
            if (string.Equals(settings.TunnelMode, "Quick", StringComparison.OrdinalIgnoreCase) && string.IsNullOrWhiteSpace(publicBaseUrl))
                throw new InvalidOperationException("Quick Tunnel 需要先启动 Cloudflare，取得公网地址后再启动 DevSpace。");

            var packageRoot = RuntimeResolver.ResolveDevSpacePackageRoot(platformRoot);
            var version = DevSpaceVersion.FromPackageJson(Path.Combine(packageRoot, "package.json"));
            var managed = settings.ToManagedDevSpaceSettings(platformRoot, publicBaseUrl);
            var plan = DevSpaceConfiguration.BuildPlan(version, managed, configDirectory);
            RuntimeResolver.AddRuntimeToolPaths(plan.EnvironmentVariables, platformRoot);
            var report = DevSpaceEffectiveStateVerifier.Verify(plan, platformRoot);
            if (!report.IsSafe) throw new InvalidDataException(string.Join(Environment.NewLine, report.Errors.ToArray()));
            DevSpaceConfiguration.WritePlan(plan);
            EnsureOwnerAuth();
            ManagedAgentInstructions.Ensure(platformRoot);

            var cliPath = Path.Combine(packageRoot, "dist", "cli.js");
            if (!File.Exists(cliPath)) throw new FileNotFoundException("找不到独立 DevSpace CLI。", cliPath);
            var startInfo = new ProcessStartInfo
            {
                FileName = RuntimeResolver.ResolveNodePath(platformRoot),
                Arguments = Quote(cliPath) + " serve",
                WorkingDirectory = platformRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            DevSpaceCliRunner.ApplyManagedEnvironment(startInfo, plan.EnvironmentVariables);

            var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args) { if (args.Data != null) OnDevSpaceOutput(args.Data); };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args) { if (args.Data != null) OnDevSpaceOutput(args.Data); };
            process.Exited += delegate { lock (sync) if (!disposing) devSpaceMessage = "已退出"; };

            EnsureJob();
            if (!process.Start()) throw new InvalidOperationException("DevSpace 进程没有启动。");
            processJob.Add(process);
            lock (sync)
            {
                devSpaceProcess = process;
                devSpaceMessage = "PID " + process.Id;
                devSpaceDesired = true;
                devSpaceOriginHealthy = false;
                devSpaceStartedUtc = DateTime.UtcNow;
                lastDevSpaceHealthProbeUtc = DateTime.MinValue;
                consecutiveDevSpaceHealthFailures = 0;
            }
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
        }

        public void StopDevSpace()
        {
            Process process;
            lock (sync)
            {
                process = devSpaceProcess;
                devSpaceProcess = null;
                devSpaceMessage = "已停止";
                devSpaceDesired = false;
                devSpaceOriginHealthy = false;
                consecutiveDevSpaceHealthFailures = 0;
            }
            StopProcess(process);
        }

        public void RestartDevSpace()
        {
            StopDevSpace();
            StartDevSpace();
        }

        public void StartCloudflare()
        {
            lock (sync) if (IsAlive(cloudflareProcess)) return;

            var settings = LoadSettings();
            var protocolArgument = CloudflareTunnelProtocol.CommandArgument(settings.CloudflaredProtocol, "auto");
            string arguments;
            if (string.Equals(settings.TunnelMode, "Remote", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsDevSpaceRunning) throw new InvalidOperationException("请先启动 DevSpace，再连接 Remote Tunnel。");
                var secretFile = CloudflareTunnelSecretStore.TokenPath(platformRoot);
                if (!CloudflareTunnelSecretStore.HasToken(platformRoot))
                    throw new InvalidOperationException("Remote Tunnel 凭据尚未配置。");
                arguments = "tunnel" + protocolArgument + " run --token-file " + Quote(secretFile);
            }
            else if (string.Equals(settings.TunnelMode, "Named", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsDevSpaceRunning) throw new InvalidOperationException("请先启动 DevSpace，再连接 Named Tunnel。");
                arguments = "tunnel" + protocolArgument + " --config " + Quote(settings.CloudflaredConfigPath) +
                    " --credentials-file " + Quote(settings.CredentialsFilePath) +
                    " --no-autoupdate run " + Quote(settings.NamedTunnelIdOrName);
            }
            else if (string.Equals(settings.TunnelMode, "Quick", StringComparison.OrdinalIgnoreCase))
            {
                dynamicPublicBaseUrl = null;
                arguments = "tunnel" + protocolArgument + " --url " + Quote("http://127.0.0.1:" + settings.LocalPort) + " --no-autoupdate";
            }
            else
            {
                throw new InvalidOperationException("Tunnel 模式尚未配置。");
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = RuntimeResolver.ResolveCloudflaredPath(platformRoot),
                Arguments = arguments,
                WorkingDirectory = platformRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args) { if (args.Data != null) OnCloudflareOutput(args.Data); };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args) { if (args.Data != null) OnCloudflareOutput(args.Data); };
            process.Exited += delegate { lock (sync) if (!disposing) cloudflareMessage = "已退出"; };

            EnsureJob();
            if (!process.Start()) throw new InvalidOperationException("cloudflared 进程没有启动。");
            processJob.Add(process);
            lock (sync)
            {
                cloudflareProcess = process;
                cloudflareMessage = "PID " + process.Id;
                cloudflareDesired = true;
                cloudflareConnections.Clear();
                cloudflareProtocol = CloudflareTunnelProtocol.Normalize(settings.CloudflaredProtocol, "auto");
                cloudflareDisconnectCount = 0;
                cloudflareNetworkTimeoutCount = 0;
                cloudflareTlsHandshakeErrorCount = 0;
                cloudflareQuicDialFailureCount = 0;
                cloudflarePrecheckFailureCount = 0;
                cloudflareStartedUtc = DateTime.UtcNow;
            }
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
        }

        public void StopCloudflare()
        {
            Process process;
            lock (sync)
            {
                process = cloudflareProcess;
                cloudflareProcess = null;
                cloudflareMessage = "已停止";
                cloudflareDesired = false;
                cloudflareConnections.Clear();
                dynamicPublicBaseUrl = null;
            }
            StopProcess(process);
        }

        public void RestartCloudflare()
        {
            StopCloudflare();
            StartCloudflare();
        }

        public void ApplyWindowsAutoStart(bool enabled)
        {
            using (var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
            {
                if (key == null) return;
                var valueName = AutoStartValueName();
                if (enabled) key.SetValue(valueName, Quote(Process.GetCurrentProcess().MainModule.FileName), RegistryValueKind.String);
                else key.DeleteValue(valueName, false);
            }
        }

        private string AutoStartValueName()
        {
            var normalizedRoot = platformRoot
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                .ToUpperInvariant();
            byte[] digest;
            using (var sha256 = SHA256.Create())
                digest = sha256.ComputeHash(Encoding.UTF8.GetBytes(normalizedRoot));
            var suffix = BitConverter.ToString(digest, 0, 8).Replace("-", string.Empty).ToLowerInvariant();
            return "DevSpaceControlPlatform-" + suffix;
        }

        public void ApplyWindowsAutoStartFromSettings()
        {
            ApplyWindowsAutoStart(LoadSettings().AutoStart);
        }

        private void OnDevSpaceOutput(string line)
        {
            var workspaceId = ToolCallWorkspaceId(line);
            if (!string.IsNullOrWhiteSpace(workspaceId))
                conversationLogs.Add(workspaceId, "DevSpace", line);
            else
            {
                AppendLog("devspace-service.log", line);
                AddServiceLog("DevSpace", line);
            }
            ObserveToolCall(line);
            lock (sync)
            {
                if (line.IndexOf("listening", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    line.IndexOf("error", StringComparison.OrdinalIgnoreCase) >= 0)
                    devSpaceMessage = line;
            }
        }

        private void OnCloudflareOutput(string line)
        {
            AppendLog("cloudflared.log", line);
            AddServiceLog("Cloudflare", line);
            var match = QuickTunnelUrlRegex.Match(line);
            if (match.Success)
            {
                var url = match.Value.TrimEnd('/');
                dynamicPublicBaseUrl = url;
                lock (sync)
                {
                    cloudflareMessage = "Quick Tunnel: " + url;
                    cloudflareConnections.Add(-1);
                }
                if (!IsDevSpaceRunning)
                {
                    try { StartDevSpaceWithPublicBaseUrl(url); }
                    catch (Exception exception) { lock (sync) devSpaceMessage = "启动失败: " + exception.Message; }
                }
                return;
            }
            var tunnelEvent = CloudflareTunnelLogClassifier.Classify(line);
            lock (sync)
            {
                if (tunnelEvent.Registered)
                {
                    cloudflareMessage = "Tunnel 已连接";
                    if (!string.IsNullOrWhiteSpace(tunnelEvent.Protocol)) cloudflareProtocol = tunnelEvent.Protocol;
                    if (tunnelEvent.ConnectionIndex >= 0) cloudflareConnections.Add(tunnelEvent.ConnectionIndex);
                }
                else if (tunnelEvent.Terminated)
                {
                    cloudflareDisconnectCount += 1;
                    if (tunnelEvent.ConnectionIndex >= 0) cloudflareConnections.Remove(tunnelEvent.ConnectionIndex);
                    if (cloudflareConnections.Count == 0) cloudflareMessage = "Tunnel 连接已中断，等待自动恢复";
                }
                if (tunnelEvent.IdleTimeout) cloudflareNetworkTimeoutCount += 1;
                if (tunnelEvent.TlsHandshakeError) cloudflareTlsHandshakeErrorCount += 1;
                if (tunnelEvent.QuicDialFailure) cloudflareQuicDialFailureCount += 1;
                if (tunnelEvent.PrecheckFailure) cloudflarePrecheckFailureCount += 1;
                if (tunnelEvent.PrecheckFailure)
                    cloudflareMessage = "Tunnel 网络预检失败 - " + line;
                else if (line.IndexOf("ERR", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    line.IndexOf("failed", StringComparison.OrdinalIgnoreCase) >= 0)
                    cloudflareMessage = line;
            }
        }

        public void MaintainConnectivity()
        {
            if (disposing) return;
            if (Interlocked.Exchange(ref connectivityCheckRunning, 1) != 0) return;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try { MaintainConnectivityCore(); }
                finally { Interlocked.Exchange(ref connectivityCheckRunning, 0); }
            });
        }

        private void MaintainConnectivityCore()
        {
            if (disposing) return;
            var now = DateTime.UtcNow;
            var settings = LoadSettings();
            var publicBaseUrl = PublicBaseUrl(settings);
            bool recoverDevSpace;
            bool recoverCloudflare;
            bool devAlive;
            bool probeDevSpace;
            bool probeEndpointReadiness;
            lock (sync)
            {
                publicEndpointConfigured = !string.IsNullOrWhiteSpace(publicBaseUrl);
                devAlive = IsAlive(devSpaceProcess);
                probeDevSpace = devAlive && (now - lastDevSpaceHealthProbeUtc).TotalSeconds >= 5;
                probeEndpointReadiness = devAlive && (now - lastEndpointReadinessProbeUtc).TotalSeconds >= 10;
            }

            bool? probeResult = probeDevSpace
                ? (bool?)ProbeLocalHttp(settings.LocalPort, 1200)
                : null;

            EndpointProbeResult localEndpointProbe = null;
            EndpointProbeResult publicEndpointProbe = null;
            if (probeEndpointReadiness && !string.IsNullOrWhiteSpace(publicBaseUrl))
            {
                localEndpointProbe = ProbeEndpointSet(publicBaseUrl, settings.LocalPort, true, 1500);
                publicEndpointProbe = ProbeEndpointSet(publicBaseUrl, settings.LocalPort, false, 2500);
            }

            string readinessChange = null;
            lock (sync)
            {
                if (!devAlive)
                {
                    devSpaceOriginHealthy = false;
                    consecutiveDevSpaceHealthFailures = 3;
                }
                else if (probeResult.HasValue)
                {
                    lastDevSpaceHealthProbeUtc = now;
                    devSpaceOriginHealthy = probeResult.Value;
                    consecutiveDevSpaceHealthFailures = probeResult.Value
                        ? 0
                        : consecutiveDevSpaceHealthFailures + 1;
                }
                if (probeEndpointReadiness)
                {
                    lastEndpointReadinessProbeUtc = now;
                    if (localEndpointProbe != null)
                    {
                        localMcpStatus = localEndpointProbe.McpStatus;
                        localAuthorizationMetadataStatus = localEndpointProbe.AuthorizationMetadataStatus;
                        localProtectedResourceMetadataStatus = localEndpointProbe.ProtectedResourceMetadataStatus;
                        localEndpointReady = localEndpointProbe.IsReady;
                    }
                    else
                    {
                        localMcpStatus = 0;
                        localAuthorizationMetadataStatus = 0;
                        localProtectedResourceMetadataStatus = 0;
                        localEndpointReady = false;
                    }
                    if (publicEndpointProbe != null)
                    {
                        publicMcpStatus = publicEndpointProbe.McpStatus;
                        publicAuthorizationMetadataStatus = publicEndpointProbe.AuthorizationMetadataStatus;
                        publicProtectedResourceMetadataStatus = publicEndpointProbe.ProtectedResourceMetadataStatus;
                        publicEndpointReady = publicEndpointProbe.IsReady;
                    }
                    else
                    {
                        publicMcpStatus = 0;
                        publicAuthorizationMetadataStatus = 0;
                        publicProtectedResourceMetadataStatus = 0;
                        publicEndpointReady = false;
                    }
                }
                recoverDevSpace = devSpaceDesired &&
                    (!devAlive || (consecutiveDevSpaceHealthFailures >= 3 &&
                                   (now - devSpaceStartedUtc).TotalSeconds >= 15));

                var cloudflareAlive = IsAlive(cloudflareProcess);
                recoverCloudflare = cloudflareDesired &&
                    (!cloudflareAlive || (cloudflareConnections.Count == 0 && (now - cloudflareStartedUtc).TotalSeconds >= 30));
                var readiness = ReadinessFormatter.Format(
                    IsAlive(devSpaceProcess),
                    localEndpointReady,
                    cloudflareAlive && cloudflareConnections.Count > 0,
                    publicEndpointConfigured,
                    publicEndpointReady,
                    lastSuccessfulMcpToolCallUtc >= devSpaceStartedUtc && lastSuccessfulMcpToolCallUtc != DateTime.MinValue,
                    publicMcpStatus,
                    publicAuthorizationMetadataStatus,
                    publicProtectedResourceMetadataStatus);
                if (!string.Equals(readiness, lastReadinessStatus, StringComparison.Ordinal))
                {
                    lastReadinessStatus = readiness;
                    readinessChange = readiness;
                }
                if ((recoverDevSpace || recoverCloudflare) && (now - lastRecoveryAttemptUtc).TotalSeconds < 8) return;
                if (recoverDevSpace || recoverCloudflare) lastRecoveryAttemptUtc = now;
            }

            if (!string.IsNullOrWhiteSpace(readinessChange))
            {
                AppendLog("devspace-service.log", "[Readiness] " + readinessChange);
                AddServiceLog("Readiness", readinessChange);
            }

            if (recoverDevSpace) RecoverService("DevSpace", RestartDevSpace);
            if (recoverCloudflare) RecoverService("Cloudflare", RestartCloudflare);
        }

        private void RecoverService(string name, Action recovery)
        {
            try
            {
                AddServiceLog("ControlPlatform", name + " 健康检查失败，正在自动重启。");
                recovery();
            }
            catch (Exception exception)
            {
                lock (sync)
                {
                    if (string.Equals(name, "DevSpace", StringComparison.Ordinal)) devSpaceDesired = true;
                    if (string.Equals(name, "Cloudflare", StringComparison.Ordinal)) cloudflareDesired = true;
                }
                AddServiceLog("ControlPlatform", name + " 自动重启失败：" + exception.Message);
            }
        }

        internal static bool ProbeLocalHttp(int port, int timeoutMilliseconds)
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/");
                request.Method = "GET";
                request.KeepAlive = false;
                request.ProtocolVersion = HttpVersion.Version10;
                request.Timeout = timeoutMilliseconds;
                request.ReadWriteTimeout = timeoutMilliseconds;
                request.Proxy = null;
                try
                {
                    using (request.GetResponse()) return true;
                }
                catch (WebException exception)
                {
                    if (exception.Response == null) return false;
                    exception.Response.Dispose();
                    return true;
                }
            }
            catch { return false; }
        }

        internal sealed class EndpointProbeResult
        {
            public int McpStatus { get; set; }
            public int AuthorizationMetadataStatus { get; set; }
            public int ProtectedResourceMetadataStatus { get; set; }
            public bool IsReady
            {
                get
                {
                    return McpStatus == 401 &&
                        AuthorizationMetadataStatus == 200 &&
                        ProtectedResourceMetadataStatus == 200;
                }
            }
        }

        private static EndpointProbeResult ProbeEndpointSet(
            string publicBaseUrl,
            int localPort,
            bool local,
            int timeoutMilliseconds)
        {
            try
            {
                var publicUri = new Uri(publicBaseUrl.TrimEnd('/'));
                var basePath = publicUri.AbsolutePath.TrimEnd('/');
                var root = local
                    ? "http://127.0.0.1:" + localPort
                    : publicUri.GetLeftPart(UriPartial.Authority);
                return new EndpointProbeResult
                {
                    McpStatus = ProbeHttpStatus(root + basePath + "/mcp", timeoutMilliseconds, local),
                    AuthorizationMetadataStatus = ProbeHttpStatus(
                        root + "/.well-known/oauth-authorization-server" + basePath,
                        timeoutMilliseconds,
                        local),
                    ProtectedResourceMetadataStatus = ProbeHttpStatus(
                        root + "/.well-known/oauth-protected-resource" + basePath + "/mcp",
                        timeoutMilliseconds,
                        local)
                };
            }
            catch
            {
                return new EndpointProbeResult();
            }
        }

        private static int ProbeHttpStatus(string url, int timeoutMilliseconds, bool bypassProxy)
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(url);
                request.Method = "GET";
                request.KeepAlive = false;
                request.AllowAutoRedirect = false;
                request.Timeout = timeoutMilliseconds;
                request.ReadWriteTimeout = timeoutMilliseconds;
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
            catch { return 0; }
        }

        private PlatformSettings LoadSettings()
        {
            return PlatformSettingsStore.Load(settingsPath, platformRoot);
        }

        private string PublicBaseUrl(PlatformSettings settings)
        {
            if (string.Equals(settings.TunnelMode, "Quick", StringComparison.OrdinalIgnoreCase)) return dynamicPublicBaseUrl;
            if ((string.Equals(settings.TunnelMode, "Remote", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(settings.TunnelMode, "Named", StringComparison.OrdinalIgnoreCase)) &&
                !string.IsNullOrWhiteSpace(settings.FixedHostname))
                return PublicEndpoint.BaseUrl(settings.FixedHostname);
            return null;
        }

        private string ResolveDevSpacePackageRoot()
        {
            var candidates = new List<string>
            {
                Path.Combine(platformRoot, "runtime", "devspace", "node_modules", "@waishnav", "devspace")
            };
            var parent = Directory.GetParent(platformRoot);
            if (parent != null) candidates.Add(Path.Combine(parent.FullName, "runtime", "devspace", "node_modules", "@waishnav", "devspace"));
            foreach (var candidate in candidates)
                if (File.Exists(Path.Combine(candidate, "package.json"))) return candidate;
            throw new DirectoryNotFoundException("找不到独立 DevSpace runtime package。");
        }

        private static string ResolveNodePath()
        {
            var candidate = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
            if (File.Exists(candidate)) return candidate;
            foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? string.Empty).Split(Path.PathSeparator))
            {
                if (string.IsNullOrWhiteSpace(directory)) continue;
                candidate = Path.Combine(directory.Trim(), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            throw new FileNotFoundException("找不到 node.exe。", "node.exe");
        }

        private string ResolveCloudflaredPath()
        {
            var candidates = new[]
            {
                Path.Combine(platformRoot, "cloudflared.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "cloudflared", "cloudflared.exe")
            };
            foreach (var candidate in candidates) if (File.Exists(candidate)) return candidate;
            throw new FileNotFoundException("找不到 cloudflared.exe。", candidates[candidates.Length - 1]);
        }

        private void EnsureOwnerAuth()
        {
            Directory.CreateDirectory(configDirectory);
            var path = Path.Combine(configDirectory, "auth.json");
            var serializer = new JavaScriptSerializer();
            var auth = File.Exists(path)
                ? serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8))
                : new Dictionary<string, object>();
            if (auth == null) auth = new Dictionary<string, object>();

            object existing;
            var value = auth.TryGetValue("ownerToken", out existing) ? Convert.ToString(existing) : string.Empty;
            if (string.IsNullOrWhiteSpace(value) || value.Length < 16)
            {
                var bytes = new byte[32];
                using (var random = new RNGCryptoServiceProvider()) random.GetBytes(bytes);
                value = Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
                auth["ownerToken"] = value;
                var temporary = path + ".tmp";
                File.WriteAllText(temporary, serializer.Serialize(auth) + Environment.NewLine, new UTF8Encoding(false));
                if (File.Exists(path)) File.Replace(temporary, path, null, true);
                else File.Move(temporary, path);
            }
            CloudflareTunnelSecretStore.RestrictPrivateFile(path);
        }

        private void EnsureJob()
        {
            if (processJob == null) processJob = new ChildProcessJob();
        }

        private void AppendLog(string name, string line)
        {
            try
            {
                Directory.CreateDirectory(logsDirectory);
                File.AppendAllText(Path.Combine(logsDirectory, name), DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " " + line + Environment.NewLine, Encoding.UTF8);
            }
            catch
            {
            }
        }

        private void AddServiceLog(string source, string line)
        {
            if (string.IsNullOrWhiteSpace(line)) return;
            lock (sync)
            {
                recentServiceLogLines.Enqueue(DateTime.Now.ToString("HH:mm:ss") + " [" + source + "] " + line);
                while (recentServiceLogLines.Count > 250) recentServiceLogLines.Dequeue();
            }
        }

        private void ObserveToolCall(string line)
        {
            if (string.IsNullOrWhiteSpace(line) || line.IndexOf("tool_call", StringComparison.OrdinalIgnoreCase) < 0) return;
            var tool = ExtractLogField(line, "tool");
            var workspaceId = ExtractLogField(line, "workspaceId");
            if (string.IsNullOrWhiteSpace(tool)) return;
            var success = ExtractLogField(line, "success");
            string openedWorkspacePath = null;
            string reviewedWorkspacePath = null;

            lock (sync)
            {
                if (string.Equals(success, "true", StringComparison.OrdinalIgnoreCase))
                    lastSuccessfulMcpToolCallUtc = DateTime.UtcNow;
                latestToolCall = tool + (string.IsNullOrWhiteSpace(workspaceId) ? string.Empty : "  " + workspaceId);
                if (!string.IsNullOrWhiteSpace(workspaceId))
                {
                    latestWorkspaceId = workspaceId;
                    conversationLatestTools[workspaceId] = tool;
                }
                if (string.Equals(tool, "show_changes", StringComparison.OrdinalIgnoreCase) &&
                    !string.IsNullOrWhiteSpace(workspaceId))
                {
                    latestReviewedWorkspaceId = workspaceId;
                    workspacePaths.TryGetValue(workspaceId, out reviewedWorkspacePath);
                }
                if (string.Equals(tool, "open_workspace", StringComparison.OrdinalIgnoreCase))
                {
                    var path = ExtractLogField(line, "path");
                    if (!string.IsNullOrWhiteSpace(path))
                    {
                        latestWorkspacePath = path.Replace("\\\\", "\\");
                        openedWorkspacePath = latestWorkspacePath;
                        if (!string.IsNullOrWhiteSpace(workspaceId)) workspacePaths[workspaceId] = latestWorkspacePath;
                    }
                }
            }
            if (!string.IsNullOrWhiteSpace(openedWorkspacePath))
            {
                try
                {
                    string projectRoot;
                    var hasRepository = DevSpaceReviewRollback.TryRepositoryRoot(openedWorkspacePath, out projectRoot);
                    if (!hasRepository) projectRoot = Path.GetFullPath(openedWorkspacePath);
                    lock (sync)
                    {
                        latestWorkspacePath = projectRoot;
                        if (!string.IsNullOrWhiteSpace(workspaceId)) workspacePaths[workspaceId] = projectRoot;
                    }
                    RememberWorkspace(projectRoot);
                    RememberConversation(workspaceId, projectRoot);
                    if (hasRepository)
                    {
                        DevSpaceReviewRollback.ObserveWorkspaceOpen(projectRoot);
                    }
                    else if (!string.IsNullOrWhiteSpace(workspaceId))
                    {
                        conversationLogs.Add(workspaceId, "ControlPlatform", "该 workspace 尚未属于 Git repository；等待模型按项目边界判断并初始化本地 Git。");
                    }
                }
                catch (Exception exception)
                {
                    if (!string.IsNullOrWhiteSpace(workspaceId))
                        conversationLogs.Add(workspaceId, "ControlPlatform", "代码版本基线失败: " + exception.Message);
                    else
                        AddServiceLog("ControlPlatform", "代码版本基线失败: " + exception.Message);
                }
                ManagedAgentInstructions.ConsumeRollbackNoticeIfMatches(platformRoot, openedWorkspacePath);
            }
            if (!string.IsNullOrWhiteSpace(reviewedWorkspacePath))
            {
                try
                {
                    string repositoryRoot;
                    if (DevSpaceReviewRollback.TryRepositoryRoot(reviewedWorkspacePath, out repositoryRoot))
                    {
                        reviewedWorkspacePath = repositoryRoot;
                        lock (sync) workspacePaths[workspaceId] = repositoryRoot;
                        RememberWorkspace(repositoryRoot);
                        RememberConversation(workspaceId, repositoryRoot);
                    }
                    if (DevSpaceReviewRollback.RecordReview(reviewedWorkspacePath, workspaceId))
                        conversationLogs.Add(workspaceId, "ControlPlatform", "已记录新的代码 Review 版本。");
                }
                catch (Exception exception)
                {
                    conversationLogs.Add(workspaceId, "ControlPlatform", "记录代码 Review 失败: " + exception.Message);
                }
            }
        }

        private static string ToolCallWorkspaceId(string line)
        {
            return !string.IsNullOrWhiteSpace(line) && line.IndexOf("tool_call", StringComparison.OrdinalIgnoreCase) >= 0
                ? ExtractLogField(line, "workspaceId")
                : string.Empty;
        }

        private void LoadKnownWorkspaces()
        {
            try
            {
                if (!File.Exists(knownWorkspacesPath)) return;
                foreach (var line in File.ReadAllLines(knownWorkspacesPath, Encoding.UTF8))
                {
                    if (!string.IsNullOrWhiteSpace(line)) knownWorkspacePaths.Add(Path.GetFullPath(line.Trim()));
                }
            }
            catch
            {
            }
        }

        private void LoadKnownConversations()
        {
            try
            {
                if (!File.Exists(knownConversationsPath)) return;
                var serializer = new JavaScriptSerializer();
                var saved = serializer.Deserialize<Dictionary<string, string>>(
                    File.ReadAllText(knownConversationsPath, Encoding.UTF8));
                if (saved == null) return;
                lock (sync)
                    foreach (var item in saved)
                        if (!string.IsNullOrWhiteSpace(item.Key) && !string.IsNullOrWhiteSpace(item.Value))
                            workspacePaths[item.Key] = Path.GetFullPath(item.Value);
            }
            catch
            {
            }
        }

        private void LoadConversationMetadata()
        {
            try
            {
                if (!File.Exists(conversationMetadataPath)) return;
                var serializer = new JavaScriptSerializer();
                var saved = serializer.Deserialize<Dictionary<string, ConversationDisplayMetadata>>(
                    File.ReadAllText(conversationMetadataPath, Encoding.UTF8));
                if (saved == null) return;
                lock (sync)
                    foreach (var item in saved)
                        if (!string.IsNullOrWhiteSpace(item.Key) && item.Value != null)
                            conversationMetadata[item.Key] = item.Value;
            }
            catch
            {
            }
        }

        private void RecoverDevSpaceWorkspaceCatalog()
        {
            var databasePath = Path.Combine(platformRoot, "state", "devspace-state", "devspace.sqlite");
            if (!File.Exists(databasePath)) return;

            string scriptPath = null;
            try
            {
                var packageRoot = RuntimeResolver.ResolveDevSpacePackageRoot(platformRoot);
                var scopeDirectory = Directory.GetParent(packageRoot);
                var nodeModulesDirectory = scopeDirectory == null ? null : scopeDirectory.Parent;
                if (nodeModulesDirectory == null) return;
                var sqliteModule = Path.Combine(nodeModulesDirectory.FullName, "better-sqlite3");
                if (!Directory.Exists(sqliteModule)) return;

                scriptPath = Path.Combine(Path.GetTempPath(), "devspace-control-workspaces-" + Guid.NewGuid().ToString("N") + ".js");
                File.WriteAllText(
                    scriptPath,
                    "const Database=require(process.argv[2]);" +
                    "const db=new Database(process.argv[3],{readonly:true,fileMustExist:true});" +
                    "try{process.stdout.write(JSON.stringify(db.prepare(\"select id, root from workspace_sessions order by last_used_at desc\").all()));}" +
                    "finally{db.close();}",
                    new UTF8Encoding(false));

                var startInfo = new ProcessStartInfo
                {
                    FileName = RuntimeResolver.ResolveNodePath(platformRoot),
                    Arguments = Quote(scriptPath) + " " + Quote(sqliteModule) + " " + Quote(databasePath),
                    WorkingDirectory = platformRoot,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                string output;
                using (var process = Process.Start(startInfo))
                {
                    output = process.StandardOutput.ReadToEnd();
                    process.StandardError.ReadToEnd();
                    process.WaitForExit(3000);
                    if (!process.HasExited || process.ExitCode != 0 || string.IsNullOrWhiteSpace(output)) return;
                }

                var rows = new JavaScriptSerializer().Deserialize<List<Dictionary<string, object>>>(output);
                if (rows == null) return;
                foreach (var row in rows)
                {
                    object idValue;
                    object rootValue;
                    if (!row.TryGetValue("id", out idValue) || !row.TryGetValue("root", out rootValue)) continue;
                    var workspaceId = Convert.ToString(idValue);
                    var workspaceRoot = Convert.ToString(rootValue);
                    if (string.IsNullOrWhiteSpace(workspaceId) || string.IsNullOrWhiteSpace(workspaceRoot) || !Directory.Exists(workspaceRoot)) continue;

                    var projectRoot = Path.GetFullPath(workspaceRoot);
                    try
                    {
                        projectRoot = DevSpaceReviewRollback.RepositoryRoot(projectRoot);
                        RememberWorkspace(projectRoot);
                    }
                    catch
                    {
                    }
                    RememberConversation(workspaceId, projectRoot);
                }
            }
            catch
            {
            }
            finally
            {
                if (!string.IsNullOrWhiteSpace(scriptPath))
                {
                    try { File.Delete(scriptPath); }
                    catch { }
                }
            }
        }

        private void RememberConversation(string workspaceId, string workspacePath)
        {
            if (string.IsNullOrWhiteSpace(workspaceId) || string.IsNullOrWhiteSpace(workspacePath)) return;
            try
            {
                lock (sync)
                {
                    workspacePaths[workspaceId] = Path.GetFullPath(workspacePath);
                    Directory.CreateDirectory(Path.GetDirectoryName(knownConversationsPath));
                    var serializer = new JavaScriptSerializer();
                    File.WriteAllText(
                        knownConversationsPath,
                        serializer.Serialize(workspacePaths) + Environment.NewLine,
                        new UTF8Encoding(false));
                }
            }
            catch
            {
            }
        }

        private void RememberWorkspace(string path)
        {
            try
            {
                var fullPath = Path.GetFullPath(path);
                lock (sync)
                {
                    if (!knownWorkspacePaths.Add(fullPath)) return;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(knownWorkspacesPath));
                File.AppendAllText(knownWorkspacesPath, fullPath + Environment.NewLine, new UTF8Encoding(false));
            }
            catch
            {
            }
        }

        private static string ExtractLogField(string line, string field)
        {
            var marker = field + "=\"";
            var start = line.IndexOf(marker, StringComparison.Ordinal);
            if (start < 0) return string.Empty;
            start += marker.Length;
            var end = start;
            while (end < line.Length)
            {
                if (line[end] == '"' && (end == start || line[end - 1] != '\\')) break;
                end++;
            }
            return end <= line.Length ? line.Substring(start, end - start) : string.Empty;
        }

        private static void StopProcess(Process process)
        {
            if (process == null) return;
            try
            {
                if (!process.HasExited)
                {
                    process.Kill();
                    process.WaitForExit(3000);
                }
            }
            catch
            {
            }
            finally
            {
                process.Dispose();
            }
        }

        private static bool IsAlive(Process process)
        {
            if (process == null) return false;
            try { return !process.HasExited; }
            catch { return false; }
        }

        private static string Quote(string value)
        {
            return "\"" + (value ?? string.Empty).Replace("\"", "\\\"") + "\"";
        }

        public void Dispose()
        {
            disposing = true;
            StopAll();
            if (processJob != null)
            {
                processJob.Dispose();
                processJob = null;
            }
        }
    }

    internal sealed class ChildProcessJob : IDisposable
    {
        private const uint JobObjectExtendedLimitInformationClass = 9;
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;
        private IntPtr handle;

        public ChildProcessJob()
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            var information = new JobObjectExtendedLimitInformation();
            information.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            var length = Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
            var pointer = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(information, pointer, false);
                if (!SetInformationJobObject(handle, JobObjectExtendedLimitInformationClass, pointer, (uint)length))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            finally { Marshal.FreeHGlobal(pointer); }
        }

        public void Add(Process process)
        {
            if (handle == IntPtr.Zero) throw new ObjectDisposedException("ChildProcessJob");
            if (!AssignProcessToJobObject(handle, process.Handle)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        public void Dispose()
        {
            if (handle == IntPtr.Zero) return;
            CloseHandle(handle);
            handle = IntPtr.Zero;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, uint informationClass, IntPtr information, uint informationLength);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectBasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectExtendedLimitInformation
        {
            public JobObjectBasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }
    }
}
