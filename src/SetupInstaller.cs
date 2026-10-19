using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
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
            ApplyOfflinePayload(platformRoot, platformRoot);
        }

        private static void ApplyOfflinePayload(string bundleRoot, string targetRoot)
        {
            var sourceRoot = Path.GetFullPath(bundleRoot);
            var root = Path.GetFullPath(targetRoot);
            try
            {
                ValidateBundle(root);
                return;
            }
            catch { if (!HasOfflinePayload(sourceRoot)) throw; }
            var gate = AcquireRuntimeUpdateGate(root, sourceRoot);
            try { ApplyOfflinePayloadUpgrade(sourceRoot, root, delegate { }, 0); }
            finally { Directory.Delete(gate); }
        }

        private static string FileSha256(string file)
        {
            using (var sha = SHA256.Create())
            using (var stream = File.OpenRead(file))
                return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }

        private static Dictionary<string, string> RuntimeFileHashes(string directory)
        {
            var result = new Dictionary<string, string>();
            var files = Directory.GetFiles(directory, "*", SearchOption.AllDirectories);
            Array.Sort(files, StringComparer.Ordinal);
            foreach (var file in files)
            {
                if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("Runtime payload contains a reparse point.");
                var relative = file.Substring(directory.Length + 1).Replace('\\', '/');
                if (relative == "READY" || relative == "slot-manifest.json") continue;
                result.Add(relative, FileSha256(file) + ":0");
            }
            return result;
        }

        private static void AtomicRuntimePointer(string file, string value)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            var temporary = file + ".tmp-" + Guid.NewGuid().ToString("N");
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                var bytes = Encoding.ASCII.GetBytes(value);
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
            }
            if (File.Exists(file)) File.Replace(temporary, file, null);
            else File.Move(temporary, file);
        }

        private static void ValidateRuntimeLauncher(string node, string cli, string version, string workingDirectory)
        {
            var psi = new ProcessStartInfo
            {
                FileName = node, Arguments = Quote(cli) + " --version", WorkingDirectory = workingDirectory,
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true
            };
            using (var process = Process.Start(psi))
            {
                if (process == null) throw new InvalidOperationException("Staged Runtime validation process was not started.");
                if (!process.WaitForExit(15000))
                {
                    if (!process.HasExited) process.Kill();
                    if (!process.WaitForExit(5000) || !process.HasExited)
                        throw new InvalidOperationException("Staged validation process exit is unconfirmed; PID=" + process.Id);
                    throw new InvalidOperationException("Staged Runtime launcher dry-run timed out; live files were preserved.");
                }
                if (process.ExitCode != 0 || !process.StandardOutput.ReadToEnd().Contains(version))
                    throw new InvalidDataException("Staged Runtime launcher dry-run failed.");
            }
        }

        private static string StageOfflinePayload(string sourceRoot, string targetRoot, string evidence)
        {
            var stage = Path.Combine(evidence, "payload");
            Directory.CreateDirectory(stage);
            ExtractOfflinePayload(sourceRoot, stage);
            var originalSlot = RuntimeResolver.ActiveRuntimeSlot(stage);
            if (string.IsNullOrWhiteSpace(originalSlot))
                throw new InvalidDataException("Update payload must contain a prepared immutable Runtime slot.");
            var stagedSlot = Path.Combine(stage, "runtime", "slots", originalSlot);
            var node = Path.Combine(stagedSlot, "node", "node.exe");
            if (!File.Exists(node) || !File.Exists(Path.Combine(stage, "cloudflared.exe")))
                throw new InvalidDataException("Update payload must contain its own Node.js and cloudflared.");
            var version = ValidateBundle(stage);
            var package = Path.Combine(stagedSlot, "devspace", "node_modules", "@waishnav", "devspace");
            var cli = Path.Combine(package, "dist", "cli.js");
            var server = Path.Combine(package, "dist", "server.js");
            if (!File.Exists(cli) || !File.Exists(server))
                throw new InvalidDataException("Runtime payload is missing CLI/server files.");
            ValidateRuntimeLauncher(node, cli, version, stage);
            var files = RuntimeFileHashes(stagedSlot);
            var serverHash = FileSha256(server);
            var provenance = Path.Combine(package, "runtime-provenance.json");
            if (File.Exists(provenance))
            {
                var record = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(provenance));
                object expected;
                if (!record.TryGetValue("server_sha256", out expected) || Convert.ToString(expected) != serverHash)
                    throw new InvalidDataException("Staged Runtime provenance hash mismatch.");
            }
            var id = "slot-" + Guid.NewGuid().ToString("N");
            var slots = Path.Combine(targetRoot, "runtime", "slots");
            Directory.CreateDirectory(slots);
            var destination = Path.Combine(slots, id);
            Directory.Move(stagedSlot, destination); // Unique destination; no existing slot is overwritten.
            foreach (var entry in files)
                if (FileSha256(Path.Combine(destination, entry.Key.Replace('/', Path.DirectorySeparatorChar))) + ":0" != entry.Value)
                    throw new InvalidDataException("Staged Runtime file hash changed during publication.");
            File.WriteAllText(Path.Combine(destination, "slot-manifest.json"), new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Serialize(new
            {
                files = files, version = version, server_sha256 = serverHash
            }), new UTF8Encoding(false));
            File.WriteAllText(Path.Combine(evidence, "target-slot.txt"), id, Encoding.ASCII);
            return stage;
        }

        private static Dictionary<string, bool> BackupUpdateFiles(string sourceRoot, string targetRoot, string backup)
        {
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var name in new[] { "DevSpaceControlPlatform.exe", "Setup.exe", "README.md", "README.zh-CN.md", "LICENSE", "control-provenance.json", "settings.json", "cloudflared.exe", @"runtime\active-slot.txt", @"state\devspace-config\config.jsonc", @"state\devspace-config\auth.json" })
                names.Add(name);
            foreach (var directory in new[] { "ops", "desktop", "payload" })
            {
                var source = Path.Combine(sourceRoot, directory);
                if (!Directory.Exists(source)) continue;
                foreach (var file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
                    names.Add(file.Substring(sourceRoot.Length + 1));
            }
            var existing = new Dictionary<string, bool>();
            foreach (var name in names)
            {
                var file = Path.Combine(targetRoot, name);
                existing.Add(name, File.Exists(file));
                if (!File.Exists(file)) continue;
                var copy = Path.Combine(backup, name);
                Directory.CreateDirectory(Path.GetDirectoryName(copy));
                File.Copy(file, copy, false);
            }
            File.WriteAllText(Path.Combine(backup, "files.json"), new JavaScriptSerializer().Serialize(existing));
            return existing;
        }

        private static void ApplyOfflinePayloadUpgrade(string sourceRoot, string targetRoot, Action afterPayload, int consolePort)
        {
            Directory.CreateDirectory(targetRoot);
            var evidence = Path.Combine(targetRoot, "state", "runtime-updates", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(evidence);
            var stage = StageOfflinePayload(sourceRoot, targetRoot, evidence);
            var backup = Path.Combine(evidence, "backup");
            Directory.CreateDirectory(backup);
            var files = BackupUpdateFiles(sourceRoot, targetRoot, backup);
            var previous = RuntimeResolver.ReadSelection(targetRoot);
            if (previous == null)
            {
                var priorSlot = RuntimeResolver.ActiveRuntimeSlot(targetRoot);
                var flatRuntime = Path.Combine(targetRoot, "runtime");
                if (string.IsNullOrEmpty(priorSlot) && File.Exists(Path.Combine(flatRuntime, "devspace", "node_modules", "@waishnav", "devspace", "package.json")))
                {
                    var legacyNode = RuntimeResolver.ResolveNodePath(targetRoot);
                    if (!Path.GetFullPath(legacyNode).StartsWith(flatRuntime + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("Legacy Runtime uses an external Node.js; no files were selected or stopped.");
                    priorSlot = "slot-" + Guid.NewGuid().ToString("N");
                    var baseline = Path.Combine(flatRuntime, "slots", priorSlot);
                    if (Directory.Exists(baseline)) throw new IOException("Baseline slot already exists.");
                    Directory.CreateDirectory(baseline);
                    var components = new Dictionary<string, string> { { "node", Path.GetDirectoryName(legacyNode) }, { "devspace", Path.Combine(flatRuntime, "devspace") } };
                    foreach (var tool in new[] { "serena", "uv" })
                        if (Directory.Exists(Path.Combine(flatRuntime, tool))) components.Add(tool, Path.Combine(flatRuntime, tool));
                    foreach (var component in components)
                    {
                        var before = RuntimeFileHashes(component.Value);
                        var destination = Path.Combine(baseline, component.Key);
                        CopyDirectoryContents(component.Value, destination);
                        var copied = RuntimeFileHashes(destination);
                        if (before.Count != copied.Count) throw new InvalidDataException("Legacy baseline file set changed during copy.");
                        foreach (var file in before)
                            if (!copied.ContainsKey(file.Key) || copied[file.Key] != file.Value) throw new InvalidDataException("Legacy baseline hash changed during copy.");
                    }
                    var package = Path.Combine(baseline, "devspace", "node_modules", "@waishnav", "devspace");
                    var version = DevSpaceVersion.FromPackageJson(Path.Combine(package, "package.json")).Raw;
                    var hash = FileSha256(Path.Combine(package, "dist", "server.js"));
                    ValidateRuntimeLauncher(Path.Combine(baseline, "node", "node.exe"), Path.Combine(package, "dist", "cli.js"), version, baseline);
                    File.WriteAllText(Path.Combine(baseline, "slot-manifest.json"), new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Serialize(new
                    {
                        files = RuntimeFileHashes(baseline), version = version, server_sha256 = hash
                    }), new UTF8Encoding(false));
                    File.WriteAllText(Path.Combine(baseline, "READY"), "ready\n");
                }
                if (!string.IsNullOrEmpty(priorSlot))
                    previous = new Dictionary<string, object>
                    {
                        { "schema_version", 1 }, { "slot", priorSlot }, { "previous", null },
                        { "server_sha256", FileSha256(Path.Combine(RuntimeResolver.ResolveDevSpacePackageRoot(targetRoot), "dist", "server.js")) }
                    };
            }
            if (previous != null) ValidateBundle(targetRoot);
            File.WriteAllText(Path.Combine(evidence, "selection-before.json"), new JavaScriptSerializer().Serialize(previous));
            var id = File.ReadAllText(Path.Combine(evidence, "target-slot.txt"), Encoding.ASCII);
            var next = new Dictionary<string, object>
            {
                { "schema_version", 1 }, { "slot", id },
                { "server_sha256", FileSha256(Path.Combine(targetRoot, "runtime", "slots", id, "devspace", "node_modules", "@waishnav", "devspace", "dist", "server.js")) },
                { "previous", previous == null ? null : new Dictionary<string, object> { { "slot", previous["slot"] }, { "server_sha256", previous["server_sha256"] } } }
            };
            var productsChanged = false;
            try
            {
                WriteRuntimeSelection(targetRoot, next);
                WriteSkippedProcessEvidence(evidence, "stop-skipped.json", StopManagedRuntimeProcesses(targetRoot));
                productsChanged = true;
                File.Copy(Path.Combine(stage, "cloudflared.exe"), Path.Combine(targetRoot, "cloudflared.exe"), true);
                ValidateBundle(targetRoot);
                afterPayload();
                if (consolePort > 0) StartAndAcceptRuntime(targetRoot, consolePort, evidence);
                File.WriteAllText(Path.Combine(evidence, "completed"), consolePort > 0 ? "New Runtime process identity and local health accepted under gate." : "Offline payload selected.");
            }
            catch (Exception original)
            {
                var failures = new List<Exception>();
                var stopped = false;
                try { WriteSkippedProcessEvidence(evidence, "recovery-stop-skipped.json", StopManagedRuntimeProcesses(targetRoot)); stopped = true; }
                catch (Exception recovery) { failures.Add(recovery); }
                try
                {
                    if (previous != null) WriteRuntimeSelection(targetRoot, previous);
                    else
                    {
                        var selection = RuntimeResolver.SelectionPath(targetRoot);
                        if (File.Exists(selection)) File.Move(selection, Path.Combine(evidence, "failed-selection.json"));
                        var mirror = Path.Combine(targetRoot, "runtime", "active-slot.txt");
                        if (File.Exists(mirror)) File.Move(mirror, Path.Combine(evidence, "failed-active-slot.txt"));
                    }
                }
                catch (Exception recovery) { failures.Add(recovery); }
                if (stopped && productsChanged)
                {
                    foreach (var entry in files)
                    {
                        if (entry.Key == @"runtime\active-slot.txt") continue; // Mirror was restored after JSON above.
                        try
                        {
                            var file = Path.Combine(targetRoot, entry.Key);
                            if (entry.Value) File.Copy(Path.Combine(backup, entry.Key), file, true);
                            else if (File.Exists(file)) File.Delete(file);
                        }
                        catch (Exception recovery) { failures.Add(recovery); }
                    }
                }
                // Once the old Runtime was confirmed stopped, it must be
                // started again even when unrelated product-file restores
                // failed: the Runtime lives in the intact immutable slot, and
                // the failure is reported separately below.
                var restarted = false;
                if ((stopped || productsChanged) && consolePort > 0 && previous != null)
                {
                    try { StartAndAcceptRuntime(targetRoot, consolePort, evidence); restarted = true; }
                    catch (Exception recovery) { failures.Add(recovery); }
                }
                try
                {
                    File.WriteAllText(Path.Combine(evidence, "recovery-status.txt"), failures.Count == 0
                        ? "Previous selection/files/process restored and accepted."
                        : (restarted ? "Recovery incomplete; previous Runtime restarted; all backups retained." : "Recovery incomplete; all backups retained."));
                }
                catch (Exception recovery) { failures.Add(recovery); }
                failures.Insert(0, original);
                throw new AggregateException("Runtime update failed. Preserved recovery evidence: " + evidence, failures);
            }
        }

        private static void WriteRuntimeSelection(string root, Dictionary<string, object> selection)
        {
            AtomicRuntimePointer(RuntimeResolver.SelectionPath(root), new JavaScriptSerializer().Serialize(selection));
            // Old desktop launchers and previous binaries still read this mirror.
            AtomicRuntimePointer(Path.Combine(root, "runtime", "active-slot.txt"), Convert.ToString(selection["slot"]) + "\n");
        }

        private static void StartAndAcceptRuntime(string root, int consolePort, string evidence)
        {
            var selection = RuntimeResolver.ReadSelection(root);
            if (selection == null) throw new InvalidDataException("Runtime selection is missing before start.");
            var package = RuntimeResolver.ResolveDevSpacePackageRoot(root);
            var node = RuntimeResolver.ResolveNodePath(root);
            var version = DevSpaceVersion.FromPackageJson(Path.Combine(package, "package.json")).Raw;
            var settings = PlatformSettingsStore.Load(Path.Combine(root, "settings.json"), root);
            var instance = "group";
            if (!string.IsNullOrWhiteSpace(settings.FixedHostname))
            {
                var segments = new Uri(PublicEndpoint.BaseUrl(settings.FixedHostname)).AbsolutePath.Trim('/').Split('/');
                if (segments.Length > 0 && !string.IsNullOrEmpty(segments[segments.Length - 1])) instance = segments[segments.Length - 1].ToLowerInvariant();
            }
            if (!Regex.IsMatch(instance, "^[a-z0-9][a-z0-9._-]*$")) throw new InvalidDataException("Invalid Control instance path.");
            var started = DateTime.UtcNow;
            var config = Path.Combine(root, "state", "devspace-config", "config.jsonc");
            var arguments = Quote(Path.Combine(root, "ops", "runtime-console.mjs")) + " --platform-root " + Quote(root) +
                " --config " + Quote(config) + " --instance " + Quote(instance) + " --serve " + consolePort;
            var auth = Path.Combine(Path.GetDirectoryName(config), "auth.json");
            if (File.Exists(auth)) arguments += " --credential-file " + Quote(auth) + " --allow-owner-copy true";
            using (var console = Process.Start(new ProcessStartInfo
            {
                FileName = node, Arguments = arguments, WorkingDirectory = root,
                UseShellExecute = false, CreateNoWindow = true
            }))
            {
                if (console == null) throw new InvalidOperationException("Updated Control Console could not be started.");
                File.WriteAllText(Path.Combine(evidence, "console-start-" + console.Id + ".json"), new JavaScriptSerializer().Serialize(new
                {
                    console_pid = console.Id, slot = selection["slot"], started_at = started.ToString("o")
                }));
                var deadline = DateTime.UtcNow.AddSeconds(45);
                while (DateTime.UtcNow < deadline)
                {
                    if (console.HasExited) throw new InvalidOperationException("Updated Control Console exited before Runtime acceptance.");
                    Dictionary<string, object> body = null;
                    try
                    {
                        var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + consolePort + "/api/status");
                        request.Proxy = null; request.AllowAutoRedirect = false; request.Timeout = 10000; request.ReadWriteTimeout = 10000;
                        using (var response = request.GetResponse())
                        using (var reader = new StreamReader(response.GetResponseStream()))
                            body = new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                    }
                    catch (WebException) { Thread.Sleep(250); continue; }
                    if (body == null || !body.ContainsKey("schema_version") || Convert.ToInt32(body["schema_version"]) != 2 ||
                        !body.ContainsKey("instance") || Convert.ToString(body["instance"]) != instance)
                        throw new InvalidDataException("Unexpected Control Console identity during Runtime acceptance.");
                    var runtime = body != null && body.ContainsKey("runtime") ? body["runtime"] as Dictionary<string, object> : null;
                    var actual = runtime != null && runtime.ContainsKey("actual") ? runtime["actual"] as Dictionary<string, object> : null;
                    if (actual == null || !actual.ContainsKey("pid") || actual["pid"] == null ||
                        !actual.ContainsKey("package_root") || actual["package_root"] == null ||
                        !actual.ContainsKey("server_sha256") || actual["server_sha256"] == null ||
                        !actual.ContainsKey("version") || actual["version"] == null) { Thread.Sleep(250); continue; }
                    if (!string.Equals(Convert.ToString(actual["package_root"]), package, StringComparison.OrdinalIgnoreCase) ||
                        Convert.ToString(actual["server_sha256"]) != Convert.ToString(selection["server_sha256"]) ||
                        Convert.ToString(actual["version"]) != version || Convert.ToString(runtime["active_slot"]) != Convert.ToString(selection["slot"]))
                        throw new InvalidDataException("New Runtime process slot/hash/version identity mismatch.");
                    var mcp = body.ContainsKey("mcp") ? body["mcp"] as Dictionary<string, object> : null;
                    var health = mcp != null && mcp.ContainsKey("local_health") ? mcp["local_health"] as Dictionary<string, object> : null;
                    using (var process = Process.GetProcessById(Convert.ToInt32(actual["pid"])))
                    {
                        if (process.HasExited || process.MainModule == null ||
                            !string.Equals(Path.GetFullPath(process.MainModule.FileName), Path.GetFullPath(node), StringComparison.OrdinalIgnoreCase) ||
                            process.StartTime.ToUniversalTime() < started.AddSeconds(-1))
                            throw new InvalidOperationException("New Runtime PID/executable/start identity could not be accepted.");
                        if (health != null && health.ContainsKey("ok") && Convert.ToBoolean(health["ok"]))
                        {
                            File.WriteAllText(Path.Combine(evidence, "accepted-" + process.Id + ".json"), new JavaScriptSerializer().Serialize(new
                            {
                                pid = process.Id, executable = process.MainModule.FileName, started_at = process.StartTime.ToUniversalTime().ToString("o"),
                                slot = selection["slot"], server_sha256 = selection["server_sha256"], version = version
                            }));
                            return;
                        }
                    }
                    Thread.Sleep(250);
                }
                throw new InvalidOperationException("New Runtime local health acceptance timed out.");
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

        public static string ExtractRemoteTunnelToken(string tokenOrInstallCommand)
        {
            var input = (tokenOrInstallCommand ?? string.Empty).Trim();
            if (input.Length == 0) return string.Empty;
            if (LooksLikeRemoteTunnelToken(input)) return input;

            var patterns = new[]
            {
                @"(?:service\s+install|--token)(?:\s+|=)(?:""(?<token>[^""]+)""|'(?<token>[^']+)'|(?<token>[A-Za-z0-9._=-]+))",
                @"(?<token>eyJ[A-Za-z0-9._=-]{30,})"
            };
            foreach (var pattern in patterns)
            {
                var match = Regex.Match(input, pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
                if (!match.Success) continue;
                var token = match.Groups["token"].Value.Trim();
                if (LooksLikeRemoteTunnelToken(token)) return token;
            }

            throw new InvalidDataException(
                "没有从 Cloudflare 安装命令中识别到 Tunnel token。请复制 Tunnel 页面 Setup Environment 中完整的 Install and Run 命令，或直接粘贴 token。");
        }

        private static bool LooksLikeRemoteTunnelToken(string value)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length < 32) return false;
            if (value.IndexOfAny(new[] { ' ', '\t', '\r', '\n', '\0' }) >= 0) return false;
            return Regex.IsMatch(value, @"^[A-Za-z0-9._=-]+$", RegexOptions.CultureInvariant);
        }

        public static Process StartTemporaryRemoteTunnel(
            string platformRoot,
            string tokenOrInstallCommand,
            out string temporaryTokenPath)
        {
            var root = Path.GetFullPath(platformRoot);
            EnsureOfflinePayload(root);
            ValidateBundle(root);
            var token = ExtractRemoteTunnelToken(tokenOrInstallCommand);
            if (token.Length == 0) throw new InvalidDataException("Cloudflare Tunnel token 不能为空。");

            var temporaryDirectory = Path.Combine(Path.GetTempPath(), "DevSpaceControlPlatform");
            Directory.CreateDirectory(temporaryDirectory);
            temporaryTokenPath = Path.Combine(
                temporaryDirectory,
                "cloudflare-tunnel-" + Guid.NewGuid().ToString("N") + ".token");
            File.WriteAllText(temporaryTokenPath, token + Environment.NewLine, new UTF8Encoding(false));
            CloudflareTunnelSecretStore.RestrictPrivateFile(temporaryTokenPath);

            var startInfo = new ProcessStartInfo
            {
                FileName = RuntimeResolver.ResolveCloudflaredPath(root),
                Arguments = "tunnel --no-autoupdate run --token-file " + Quote(temporaryTokenPath),
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            process.OutputDataReceived += delegate { };
            process.ErrorDataReceived += delegate { };
            var tokenPathForCleanup = temporaryTokenPath;
            process.Exited += delegate
            {
                try { File.Delete(tokenPathForCleanup); } catch { }
            };
            try
            {
                if (!process.Start()) throw new InvalidOperationException("cloudflared Connector 没有启动。");
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                Thread.Sleep(900);
                if (process.HasExited)
                    throw new InvalidOperationException("cloudflared Connector 启动后立即退出，请检查 Tunnel 命令是否来自当前 Tunnel。");
                return process;
            }
            catch
            {
                process.Dispose();
                try { File.Delete(temporaryTokenPath); } catch { }
                temporaryTokenPath = string.Empty;
                throw;
            }
        }

        public static void StopTemporaryRemoteTunnel(Process process, string temporaryTokenPath)
        {
            if (process != null)
            {
                try
                {
                    if (!process.HasExited)
                    {
                        process.Kill();
                        process.WaitForExit(5000);
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
            if (!string.IsNullOrWhiteSpace(temporaryTokenPath))
            {
                try { File.Delete(temporaryTokenPath); } catch { }
            }
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

        public static string ModernDesktopLauncherPath(string platformRoot)
        {
            return Path.Combine(Path.GetFullPath(platformRoot), "ops", "start-modern-desktop.ps1");
        }

        public static string ModernDesktopExecutablePath(string platformRoot)
        {
            return Path.Combine(Path.GetFullPath(platformRoot), "desktop", "DevSpaceForgeDesktop.exe");
        }

        private static string WindowsDesktopPowerShellArguments(string platformRoot)
        {
            var root = Path.GetFullPath(platformRoot);
            return "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " +
                Quote(ModernDesktopLauncherPath(root)) + " -PlatformRoot " + Quote(root);
        }

        public static string WindowsAutoStartCommand(string platformRoot)
        {
            return "powershell.exe " + WindowsDesktopPowerShellArguments(platformRoot);
        }

        public static void ApplyWindowsLaunchShortcuts(string platformRoot)
        {
            var root = Path.GetFullPath(platformRoot);
            var iconPath = Path.Combine(root, "desktop", "resources", "app", "DevSpaceForge.ico");
            var shortcutName = "DevSpace-Forge.lnk";
            var programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            if (string.IsNullOrWhiteSpace(programs) || string.IsNullOrWhiteSpace(desktop))
                throw new InvalidOperationException("无法解析当前用户的开始菜单或桌面目录。");

            var programsShortcut = Path.Combine(programs, shortcutName);
            var desktopShortcut = Path.Combine(desktop, shortcutName);
            var hadProgramsShortcut = File.Exists(programsShortcut);
            var hadDesktopShortcut = File.Exists(desktopShortcut);
            CreateWindowsShortcut(programsShortcut, root, iconPath);
            if (!hadProgramsShortcut && !hadDesktopShortcut)
                CreateWindowsShortcut(desktopShortcut, root, iconPath);
        }

        private static void CreateWindowsShortcut(string shortcutPath, string platformRoot, string iconPath)
        {
            var directory = Path.GetDirectoryName(shortcutPath);
            if (string.IsNullOrWhiteSpace(directory))
                throw new InvalidDataException("Windows 快捷方式路径无效：" + shortcutPath);
            Directory.CreateDirectory(directory);

            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null)
                throw new InvalidOperationException("Windows Script Host 不可用，无法创建 DevSpace-Forge 快捷方式。");

            object shell = null;
            object shortcut = null;
            try
            {
                shell = Activator.CreateInstance(shellType);
                shortcut = shellType.InvokeMember(
                    "CreateShortcut",
                    BindingFlags.InvokeMethod,
                    null,
                    shell,
                    new object[] { shortcutPath });
                var shortcutType = shortcut.GetType();
                shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut,
                    new object[] { "powershell.exe" });
                shortcutType.InvokeMember("Arguments", BindingFlags.SetProperty, null, shortcut,
                    new object[] { WindowsDesktopPowerShellArguments(platformRoot) });
                shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut,
                    new object[] { Path.GetFullPath(platformRoot) });
                shortcutType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut,
                    new object[] { iconPath + ",0" });
                shortcutType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut,
                    new object[] { "Open DevSpace-Forge" });
                shortcutType.InvokeMember("WindowStyle", BindingFlags.SetProperty, null, shortcut,
                    new object[] { 7 });
                shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            }
            finally
            {
                if (shortcut != null && Marshal.IsComObject(shortcut)) Marshal.FinalReleaseComObject(shortcut);
                if (shell != null && Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell);
            }
        }

        private static void ValidateModernDesktopBundle(string platformRoot)
        {
            var root = Path.GetFullPath(platformRoot);
            var required = new[]
            {
                ModernDesktopExecutablePath(root),
                ModernDesktopLauncherPath(root),
                Path.Combine(root, "ops", "start-runtime-console.ps1"),
                Path.Combine(root, "ops", "runtime-console.mjs"),
                Path.Combine(root, "ops", "control-service-controller.mjs"),
                Path.Combine(root, "ops", "windows-process-job.mjs"),
                Path.Combine(root, "ops", "managed-cloudflared.mjs"),
                Path.Combine(root, "ops", "prepare-effective-config.mjs"),
                Path.Combine(root, "ops", "control-ui", "index.html")
            };
            foreach (var file in required)
                if (!File.Exists(file)) throw new FileNotFoundException("现代桌面安装包缺少必要文件。", file);
        }

        public static void StartWindowsDesktop(string platformRoot)
        {
            var root = Path.GetFullPath(platformRoot);
            ValidateModernDesktopBundle(root);
            var process = Process.Start(new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = WindowsDesktopPowerShellArguments(root),
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            });
            if (process == null) throw new InvalidOperationException("无法启动 DevSpace-Forge Desktop。");
            process.Dispose();
        }

        internal static string LegacyWindowsAutoStartValueName(string platformRoot)
        {
            var normalizedRoot = Path.GetFullPath(platformRoot)
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                .ToUpperInvariant();
            byte[] digest;
            using (var sha256 = SHA256.Create())
                digest = sha256.ComputeHash(Encoding.UTF8.GetBytes(normalizedRoot));
            var suffix = BitConverter.ToString(digest, 0, 8).Replace("-", string.Empty).ToLowerInvariant();
            return "DevSpaceControlPlatform-" + suffix;
        }

        public static void ApplyWindowsAutoStart(string platformRoot, bool enabled)
        {
            using (var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
            {
                if (key == null) throw new InvalidOperationException("无法打开 Windows 当前用户启动项。\n请检查当前用户注册表权限。");
                var legacyValueName = LegacyWindowsAutoStartValueName(platformRoot);
                if (enabled)
                {
                    ValidateModernDesktopBundle(platformRoot);
                    key.SetValue("DevSpaceControlPlatform", WindowsAutoStartCommand(platformRoot), RegistryValueKind.String);
                    key.DeleteValue(legacyValueName, false);
                }
                else
                {
                    key.DeleteValue("DevSpaceControlPlatform", false);
                    key.DeleteValue(legacyValueName, false);
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

            var token = string.IsNullOrWhiteSpace(tunnelToken)
                ? string.Empty
                : ExtractRemoteTunnelToken(tunnelToken);
            if (token.Length == 0 && !CloudflareTunnelSecretStore.HasToken(root))
                throw new InvalidDataException("请粘贴 Cloudflare Tunnel 的 Install and Run 命令或 token。");

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
            PlatformSettingsStore.Save(settingsPath, settings);

            if (token.Length > 0) CloudflareTunnelSecretStore.SaveToken(root, token);
            ApplyWindowsAutoStart(root, autoStart);
            ApplyWindowsLaunchShortcuts(root);

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
            return UpdateExisting(bundleRoot, platformRoot, applySystemIntegration, 17678);
        }

        internal static SetupInstallResult UpdateExisting(
            string bundleRoot,
            string platformRoot,
            bool applySystemIntegration,
            int consolePort)
        {
            ValidatePort(consolePort);
            var root = Path.GetFullPath(platformRoot);
            var sourceRoot = Path.GetFullPath(bundleRoot);
            var settingsPath = Path.Combine(root, "settings.json");
            if (!File.Exists(settingsPath))
                throw new FileNotFoundException("未找到现有 settings.json，不能执行直接更新。", settingsPath);

            var settings = PlatformSettingsStore.Load(settingsPath, root);
            ValidateModernDesktopBundle(sourceRoot);
            if (string.Equals(settings.TunnelMode, "Remote", StringComparison.OrdinalIgnoreCase) &&
                !CloudflareTunnelSecretStore.HasToken(root))
            {
                throw new InvalidDataException("现有 Remote Tunnel 配置缺少本地 Token，无法无交互更新。");
            }
            if (applySystemIntegration) ApplyWindowsLaunchShortcuts(root);

            // The native updater is not behind the Node Console's guard.
            // Hold the same atomic directory while checking jobs and replacing
            // the runtime, before the first process is stopped.
            string gateNonce;
            var restartGate = AcquireRuntimeUpdateGate(root, sourceRoot, out gateNonce);
            try
            {
                SetupInstallResult result = null;
                ApplyOfflinePayloadUpgrade(sourceRoot, root, delegate
                {
                    CopyProductFiles(sourceRoot, root);
                    var versionText = ValidateBundle(root);
                    PlatformSettingsStore.Save(settingsPath, settings);
                    if (applySystemIntegration) ApplyWindowsAutoStart(root, settings.AutoStart);
                    result = FinalizeConfiguration(root, settings, versionText, true);
                    if (applySystemIntegration) RememberInstallationRoot(root);
                }, consolePort);
                return result;
            }
            finally
            {
                // Only the updater that acquired this gate removes it. Never
                // auto-clear a gate whose owner cannot be proven to be us.
                ReleaseRuntimeUpdateGate(restartGate, gateNonce);
            }
        }

        internal static string AcquireRuntimeUpdateGate(string platformRoot, string bundleRoot, out string nonce)
        {
            var stateDir = RuntimeResolver.StateDirectory(platformRoot);
            Directory.CreateDirectory(stateDir);
            var gate = Path.Combine(stateDir, ".runtime-switch-gate");
            nonce = Guid.NewGuid().ToString("N");
            if (!PublishRuntimeUpdateGate(gate, nonce))
            {
                ReleaseRuntimeUpdateGate(gate, nonce); // Never leave a half-published gate of ours.
                if (!ReclaimDeadRuntimeUpdateGate(gate) || !PublishRuntimeUpdateGate(gate, nonce))
                {
                    ReleaseRuntimeUpdateGate(gate, nonce);
                    throw new InvalidOperationException("Runtime switch gate is held or unavailable; update was not started.");
                }
            }
            try
            {
                if (Directory.Exists(Path.Combine(stateDir, "jobs")))
                {
                    var script = Path.Combine(bundleRoot, "ops", "check-runtime-jobs.mjs");
                    if (!File.Exists(script))
                        throw new InvalidDataException("Update payload is missing the durable job preflight.");
                    var node = RuntimeResolver.ResolveNodePath(platformRoot);
                    var psi = new ProcessStartInfo
                    {
                        FileName = node,
                        Arguments = Quote(script) + " " + Quote(stateDir),
                        WorkingDirectory = bundleRoot,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true
                    };
                    using (var process = Process.Start(psi))
                    {
                        if (process == null || !process.WaitForExit(10000))
                        {
                            if (process != null) try { process.Kill(); } catch { }
                            throw new InvalidOperationException("Durable job preflight timed out; update was not started.");
                        }
                        if (process.ExitCode != 0)
                            throw new InvalidOperationException("Durable job state is active or unavailable; update was not started.");
                    }
                }
                return gate;
            }
            catch
            {
                ReleaseRuntimeUpdateGate(gate, nonce);
                throw;
            }
        }

        // Crash-safe publication: a populated temporary directory is renamed
        // into place, so a crash can never leave a gate without its owner.
        // Keep this protocol in sync with ops/runtime-jobs-guard.mjs and
        // runtime-src/src/runtime-switch-gate.ts.
        private static bool PublishRuntimeUpdateGate(string gate, string nonce)
        {
            var proposed = gate + ".tmp-" + Process.GetCurrentProcess().Id + "-" + nonce;
            try
            {
                Directory.CreateDirectory(proposed);
                var owner = new Dictionary<string, object>
                {
                    { "pid", Process.GetCurrentProcess().Id },
                    { "processStartIdentity", CurrentProcessStartIdentity() },
                    { "createdAt", (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds },
                    { "nonce", nonce }
                };
                var bytes = new UTF8Encoding(false).GetBytes(new JavaScriptSerializer().Serialize(owner));
                using (var stream = new FileStream(Path.Combine(proposed, "owner.json"),
                    FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush(true);
                }
                if (Directory.Exists(gate)) return false;
                Directory.Move(proposed, gate);
                return string.Equals(Convert.ToString(ReadRuntimeGateOwner(gate)["nonce"]), nonce,
                    StringComparison.Ordinal);
            }
            catch (Exception)
            {
                return false;
            }
            finally
            {
                try { if (Directory.Exists(proposed)) Directory.Delete(proposed, true); } catch (Exception) { }
            }
        }

        private static Dictionary<string, object> ReadRuntimeGateOwner(string gate)
        {
            Dictionary<string, object> owner;
            try
            {
                owner = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(
                    File.ReadAllText(Path.Combine(gate, "owner.json"), Encoding.UTF8));
            }
            catch (Exception error)
            {
                throw new InvalidDataException("Runtime switch gate owner is unreadable.", error);
            }
            object pid, createdAt, identity, ownerNonce;
            if (owner == null || !owner.TryGetValue("pid", out pid) ||
                !owner.TryGetValue("createdAt", out createdAt) ||
                !owner.TryGetValue("processStartIdentity", out identity) ||
                !owner.TryGetValue("nonce", out ownerNonce) ||
                Convert.ToInt64(pid) < 1 || Convert.ToInt64(createdAt) <= 0 ||
                string.IsNullOrEmpty(Convert.ToString(ownerNonce)) ||
                (identity != null && !(identity is string)))
                throw new InvalidDataException("Invalid Runtime switch gate owner.");
            return owner;
        }

        private static bool ReclaimDeadRuntimeUpdateGate(string gate)
        {
            Dictionary<string, object> owner;
            try { owner = ReadRuntimeGateOwner(gate); } catch (Exception) { return false; }
            if (!string.Equals(GateOwnerProcessState(owner), "inactive", StringComparison.Ordinal)) return false;
            var stale = gate + ".stale-" + Guid.NewGuid().ToString("N");
            try
            {
                Directory.Move(gate, stale);
                if (!SameGateOwner(owner, ReadRuntimeGateOwner(stale)))
                {
                    try { if (!Directory.Exists(gate)) Directory.Move(stale, gate); } catch (Exception) { }
                    return false;
                }
                Directory.Delete(stale, true);
                return true;
            }
            catch (Exception)
            {
                try { if (!Directory.Exists(gate)) Directory.Move(stale, gate); } catch (Exception) { }
                return false;
            }
        }

        private static bool SameGateOwner(Dictionary<string, object> left, Dictionary<string, object> right)
        {
            foreach (var key in new[] { "pid", "createdAt", "processStartIdentity", "nonce" })
            {
                object leftValue, rightValue;
                left.TryGetValue(key, out leftValue);
                right.TryGetValue(key, out rightValue);
                if (!string.Equals(Convert.ToString(leftValue), Convert.ToString(rightValue), StringComparison.Ordinal))
                    return false;
            }
            return true;
        }

        private static string GateOwnerProcessState(Dictionary<string, object> owner)
        {
            var pid = Convert.ToInt32(owner["pid"]);
            var expected = owner["processStartIdentity"] == null
                ? null
                : Convert.ToString(owner["processStartIdentity"]);
            Process process;
            try { process = Process.GetProcessById(pid); }
            catch (ArgumentException) { return "inactive"; }
            catch (InvalidOperationException) { return "inactive"; }
            using (process)
            {
                try
                {
                    if (process.HasExited) return "inactive";
                    if (string.IsNullOrEmpty(expected)) return "unknown";
                    var actual = ProcessStartIdentity(process);
                    if (actual == null) return "unknown";
                    return string.Equals(actual, expected, StringComparison.Ordinal) ? "active" : "inactive";
                }
                catch (Exception) { return "unknown"; }
            }
        }

        private static string CurrentProcessStartIdentity()
        {
            using (var process = Process.GetCurrentProcess()) return ProcessStartIdentity(process);
        }

        // Same identity format as the Node guard: Windows .NET ticks, or the
        // Linux /proc start field, prefixed with the platform.
        private static string ProcessStartIdentity(Process process)
        {
            try
            {
                if (Environment.OSVersion.Platform == PlatformID.Win32NT)
                    return "windows:" + process.StartTime.ToUniversalTime().Ticks;
                if (Environment.OSVersion.Platform == PlatformID.Unix)
                {
                    var stat = File.ReadAllText("/proc/" + process.Id + "/stat");
                    var fields = stat.Substring(stat.LastIndexOf(')') + 2).Split(' ');
                    return fields.Length > 19 && !string.IsNullOrEmpty(fields[19])
                        ? "linux:" + fields[19]
                        : null;
                }
            }
            catch (Exception)
            {
            }
            return null;
        }

        private static void ReleaseRuntimeUpdateGate(string gate, string nonce)
        {
            for (var attempt = 0; attempt < 5; attempt++)
            {
                try
                {
                    if (!string.Equals(Convert.ToString(ReadRuntimeGateOwner(gate)["nonce"]), nonce,
                        StringComparison.Ordinal)) return;
                }
                catch (Exception) { return; } // An uncertain owner must remain blocking.
                var released = gate + ".released-" + Guid.NewGuid().ToString("N");
                try
                {
                    Directory.Move(gate, released);
                }
                catch (Exception)
                {
                    if (attempt < 4)
                    {
                        Thread.Sleep(20 * (attempt + 1));
                        continue;
                    }
                    try
                    {
                        if (!string.Equals(Convert.ToString(ReadRuntimeGateOwner(gate)["nonce"]), nonce,
                            StringComparison.Ordinal)) return;
                        File.Delete(Path.Combine(gate, "owner.json"));
                        Directory.Delete(gate);
                    }
                    catch (Exception) { }
                    return;
                }
                try { Directory.Delete(released, true); } catch (Exception) { }
                return;
            }
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
                "control-provenance.json"
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
                "runtime-rollback.mjs",
                "runtime-jobs-guard.mjs",
                "check-runtime-jobs.mjs",
                "control-management.mjs",
                "control-service-controller.mjs",
                "windows-process-job.mjs",
                "managed-cloudflared.mjs",
                "prepare-effective-config.mjs",
                "runtime-console-ui.html",
                "runtime-console-ui.css",
                "runtime-console-ui.js",
                "start-runtime-console.ps1",
                "start-modern-desktop.ps1"
            })
            {
                var from = Path.Combine(sourceOps, fileName);
                if (!File.Exists(from)) continue;
                Directory.CreateDirectory(targetOps);
                File.Copy(from, Path.Combine(targetOps, fileName), true);
            }
            CopyDirectoryContents(Path.Combine(sourceOps, "control-ui"), Path.Combine(targetOps, "control-ui"));
            CopyDirectoryContents(Path.Combine(source, "desktop"), Path.Combine(target, "desktop"));

            var sourcePayload = OfflinePayloadPath(source);
            if (File.Exists(sourcePayload))
            {
                var targetPayload = OfflinePayloadPath(target);
                Directory.CreateDirectory(Path.GetDirectoryName(targetPayload));
                File.Copy(sourcePayload, targetPayload, true);
            }
        }

        private static void CopyDirectoryContents(string sourceDirectory, string targetDirectory)
        {
            if (!Directory.Exists(sourceDirectory))
                throw new DirectoryNotFoundException("产品目录缺失：" + sourceDirectory);
            Directory.CreateDirectory(targetDirectory);
            foreach (var file in Directory.GetFiles(sourceDirectory))
                File.Copy(file, Path.Combine(targetDirectory, Path.GetFileName(file)), true);
            foreach (var directory in Directory.GetDirectories(sourceDirectory))
                CopyDirectoryContents(directory, Path.Combine(targetDirectory, Path.GetFileName(directory)));
        }

        internal static List<string> StopManagedRuntimeProcesses(string platformRoot)
        {
            var root = Path.GetFullPath(platformRoot).TrimEnd(Path.DirectorySeparatorChar) +
                Path.DirectorySeparatorChar;
            var skipped = new List<string>();
            for (var pass = 0; pass < 2; pass++)
            {
                foreach (var processName in new[] { "DevSpaceControlPlatform", "DevSpaceForgeDesktop", "node", "cloudflared" })
                {
                    foreach (var process in Process.GetProcessesByName(processName))
                    {
                        var executableIdentity = "unavailable";
                        var startIdentity = "unavailable";
                        var pid = 0;
                        var owned = false;
                        try
                        {
                            pid = process.Id;
                            if (pid == Process.GetCurrentProcess().Id) continue;
                            if (process.HasExited) continue;
                            string executable;
                            try
                            {
                                var module = process.MainModule;
                                executable = module == null ? string.Empty : module.FileName;
                            }
                            catch (Exception unreadable)
                            {
                                // Another user's or a protected same-named process
                                // is not ours; it must not abort the sweep.
                                skipped.Add("name=" + processName + ", PID=" + pid +
                                    ": executable identity is unavailable; ownership not proven (" +
                                    unreadable.Message + ").");
                                continue;
                            }
                            if (string.IsNullOrWhiteSpace(executable))
                            {
                                skipped.Add("name=" + processName + ", PID=" + pid +
                                    ": empty executable identity; ownership not proven.");
                                continue;
                            }
                            var fullPath = Path.GetFullPath(executable);
                            executableIdentity = fullPath;
                            if (!fullPath.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;
                            owned = true; // From here a failure aborts: this process is ours.
                            var identity = process.StartTime.ToUniversalTime();
                            startIdentity = identity.ToString("o");
                            if (pass == 1) throw new InvalidOperationException("A managed process remained after the confirmed-stop sweep.");
                            if (process.CloseMainWindow() && process.WaitForExit(2500)) continue;
                            if (process.HasExited) continue;
                            if (process.StartTime.ToUniversalTime() != identity)
                                throw new InvalidOperationException("Process identity changed before stop.");
                            if (!process.HasExited) process.Kill();
                            if (!process.WaitForExit(5000) || !process.HasExited)
                                throw new InvalidOperationException("Process exit could not be confirmed within 5000ms.");
                        }
                        catch (Exception error)
                        {
                            if (!owned)
                            {
                                // Even the process state was unreadable; it is
                                // not proven ours, so skip it instead of aborting.
                                skipped.Add("name=" + processName + ", PID=" + pid +
                                    ": process state is unreadable; ownership not proven (" +
                                    error.Message + ").");
                                continue;
                            }
                            throw new InvalidOperationException(
                                "Managed process stop is unconfirmed (name=" + processName + ", PID=" + pid +
                                ", start=" + startIdentity + ", executable=" + executableIdentity +
                                "). Update aborted; inspect this process before retrying.", error);
                        }
                        finally
                        {
                            process.Dispose();
                        }
                    }
                }
            }
            return skipped;
        }

        private static void WriteSkippedProcessEvidence(string evidence, string fileName, List<string> skipped)
        {
            if (skipped.Count == 0) return;
            try
            {
                File.WriteAllText(Path.Combine(evidence, fileName),
                    new JavaScriptSerializer().Serialize(skipped), new UTF8Encoding(false));
            }
            catch (Exception)
            {
                // Diagnostics must not change the stop or recovery outcome.
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
