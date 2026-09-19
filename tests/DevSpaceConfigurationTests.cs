using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Web.Script.Serialization;
using DevSpaceControlPlatform;

internal static class DevSpaceConfigurationTests
{
    private static int failures;

    private static void Main()
    {
        Run("parse 1.0.8", TestLegacyVersion);
        Run("parse 1.1 prerelease", TestModernVersion);
        Run("read version from package json", TestPackageVersion);
        Run("reject unknown future major", TestUnknownMajor);
        Run("reject unverified 1.2", TestUnknownMinor);
        Run("legacy plan uses legacy config and env", TestLegacyPlan);
        Run("modern plan uses jsonc and no removed env", TestModernPlan);
        Run("modern rejects legacy tool modes", TestModernRejectsLegacyToolMode);
        Run("effective state accepts safe legacy plan", TestLegacySecurity);
        Run("effective state accepts safe modern plan", TestModernSecurity);
        Run("effective state rejects enabled modern subagents", TestModernSecurityRejectsSubagents);
        Run("managed CLI isolates modern DevSpace env", TestModernCliEnvironmentIsolation);
        Run("managed CLI applies legacy effective env", TestLegacyCliEnvironment);
        Run("setup normalizes tunnel hostname and MCP links", TestSetupHostnameNormalization);
        Run("setup expands offline runtime payload", TestSetupOfflinePayload);
        Run("runtime PATH exposes project Serena and uv tools", TestRuntimeToolPath);
        Run("runtime slot pointer selects isolated node and DevSpace", TestRuntimeSlotSelection);
        Run("invalid runtime slot pointer fails closed", TestInvalidRuntimeSlotPointer);
        Run("configuration history snapshots and trims", TestConfigurationHistory);
        Run("legacy QuickConfig migration preserves operational settings", TestLegacyQuickConfigMigration);
        Run("legacy minimal maps to claude for 1.1", TestLegacyToolModeMigration);
        Run("review rollback can walk backward across review chain", TestReviewRollback);
        Run("review histories isolate independent projects", TestIndependentProjectReviewHistories);
        Run("project identity follows real git repository", TestProjectRepositoryIdentity);
        Run("unborn git repository supports review history", TestUnbornRepositoryReviewHistory);
        Run("non-git workspace gets local version baseline", TestNonGitWorkspaceInitialization);
        Run("rollback notice is one-shot managed context", TestRollbackNotice);
        Run("conversation logs isolate workspace sessions", TestConversationLogIsolation);

        if (failures != 0)
        {
            Console.Error.WriteLine(failures + " test(s) failed.");
            Environment.Exit(1);
        }
        Console.WriteLine("All DevSpace configuration tests passed.");
    }

    private static void TestLegacyVersion()
    {
        var version = DevSpaceVersion.Parse("@waishnav/devspace 1.0.8");
        AssertEqual(DevSpaceConfigFamily.Legacy10, version.Family, "family");
        AssertEqual("1.0.8", version.ToString(), "version");
    }

    private static void TestModernVersion()
    {
        var version = DevSpaceVersion.Parse("v1.1.0-beta.1");
        AssertEqual(DevSpaceConfigFamily.Modern11, version.Family, "family");
        AssertEqual("1.1.0", version.ToString(), "version");
        AssertEqual("v1.1.0-beta.1", version.Raw, "raw version");
    }

    private static void TestUnknownMajor()
    {
        AssertThrows<NotSupportedException>(delegate { DevSpaceVersion.Parse("2.0.0"); });
    }

    private static void TestUnknownMinor()
    {
        AssertThrows<NotSupportedException>(delegate { DevSpaceVersion.Parse("1.2.0"); });
    }

    private static void TestPackageVersion()
    {
        var root = TestRoot("package-version");
        var packagePath = Path.Combine(root, "package.json");
        File.WriteAllText(packagePath, "{\"version\":\"1.1.0-beta.1\"}");
        AssertEqual(DevSpaceConfigFamily.Modern11, DevSpaceVersion.FromPackageJson(packagePath).Family, "package version family");
    }

    private static void TestLegacyPlan()
    {
        var root = TestRoot("legacy");
        var settings = ManagedDevSpaceSettings.CreateDefault(root);
        settings.AllowedRoots.Add(Path.Combine(root, "second"));
        Directory.CreateDirectory(settings.AllowedRoots[1]);
        settings.ToolMode = "minimal";

        var configDir = Path.Combine(root, "managed-config");
        var plan = DevSpaceConfiguration.BuildPlan(
            DevSpaceVersion.Parse("1.0.8"), settings, configDir);
        DevSpaceConfiguration.WritePlan(plan);

        AssertEqual("config.json", Path.GetFileName(plan.ConfigPath), "legacy config filename");
        AssertEqual("0", plan.EnvironmentVariables["DEVSPACE_SUBAGENTS"], "subagents env");
        AssertEqual("minimal", plan.EnvironmentVariables["DEVSPACE_TOOL_MODE"], "tool mode env");
        AssertEqual("changes", plan.EnvironmentVariables["DEVSPACE_WIDGETS"], "review widgets env");

        var json = ReadObject(plan.ConfigPath);
        AssertEqual(false, json["subagents"], "legacy persisted subagents");
        AssertEqual(2, ((object[])json["allowedRoots"]).Length, "legacy roots");
    }

    private static void TestSetupHostnameNormalization()
    {
        AssertEqual("devspace.example.com", SetupInstaller.NormalizeHostname("devspace.example.com"), "plain hostname");
        AssertEqual("devspace.example.com", SetupInstaller.NormalizeHostname("https://devspace.example.com"), "https origin");
        AssertEqual("devspace.example.com", SetupInstaller.NormalizeHostname("https://devspace.example.com/mcp"), "full MCP URL");
        AssertEqual("http://127.0.0.1:7677", SetupInstaller.LocalOrigin(7677), "local origin");
        AssertEqual("http://127.0.0.1:7677/mcp", SetupInstaller.LocalMcpUrl(7677), "local MCP URL");
        AssertEqual("https://devspace.example.com/mcp", SetupInstaller.PublicMcpUrl("devspace.example.com"), "public MCP URL");
        AssertTrue(SetupInstaller.IsAcceptableEndpointStatus(200), "setup accepts HTTP 200");
        AssertTrue(SetupInstaller.IsAcceptableEndpointStatus(302), "setup accepts Access redirect");
        AssertTrue(SetupInstaller.IsAcceptableEndpointStatus(401), "setup accepts auth challenge");
        AssertTrue(SetupInstaller.IsAcceptableEndpointStatus(403), "setup accepts Access denial as reachable edge");
        AssertTrue(SetupInstaller.IsAcceptableEndpointStatus(405), "setup accepts MCP method response");
        AssertEqual(false, SetupInstaller.IsAcceptableEndpointStatus(404), "setup rejects wrong route");
        AssertEqual(false, SetupInstaller.IsAcceptableEndpointStatus(502), "setup rejects bad gateway");
        AssertEqual(false, SetupInstaller.IsAcceptableEndpointStatus(530), "setup rejects Cloudflare origin failure");
        var autoStartRoot = Path.Combine(Path.GetTempPath(), "devspace-control-autostart");
        AssertEqual(
            "\"" + Path.Combine(Path.GetFullPath(autoStartRoot), "DevSpaceControlPlatform.exe") + "\"",
            SetupInstaller.WindowsAutoStartCommand(autoStartRoot),
            "Windows setup autostart command");
        AssertThrows<InvalidDataException>(delegate { SetupInstaller.NormalizeHostname("http://devspace.example.com"); });
        AssertThrows<InvalidDataException>(delegate { SetupInstaller.NormalizeHostname("https://devspace.example.com/not-mcp"); });
    }

    private static void TestSetupOfflinePayload()
    {
        var root = Path.Combine(Path.GetTempPath(), "devspace-control-setup-payload-" + Guid.NewGuid().ToString("N"));
        var source = Path.Combine(root, "source");
        var install = Path.Combine(root, "install");
        Directory.CreateDirectory(Path.Combine(source, "runtime", "slots", "offline-test", "node"));
        Directory.CreateDirectory(Path.Combine(source, "runtime", "slots", "offline-test", "devspace", "node_modules", "@waishnav", "devspace"));
        File.WriteAllText(Path.Combine(source, "runtime", "active-slot.txt"), "offline-test\n");
        File.WriteAllText(Path.Combine(source, "runtime", "slots", "offline-test", "READY"), "ready\n");
        File.WriteAllBytes(Path.Combine(source, "runtime", "slots", "offline-test", "node", "node.exe"), new byte[] { 1 });
        File.WriteAllText(
            Path.Combine(source, "runtime", "slots", "offline-test", "devspace", "node_modules", "@waishnav", "devspace", "package.json"),
            "{\"version\":\"1.1.0-beta.4+offline.test\"}");
        File.WriteAllBytes(Path.Combine(source, "cloudflared.exe"), new byte[] { 1 });
        Directory.CreateDirectory(Path.Combine(install, "payload"));
        var payload = Path.Combine(install, "payload", "runtime.tar");

        var tar = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "tar.exe");
        var startInfo = new ProcessStartInfo
        {
            FileName = tar,
            Arguments = "-cf \"" + payload + "\" runtime cloudflared.exe",
            WorkingDirectory = source,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        using (var process = Process.Start(startInfo))
        {
            var stderr = process.StandardError.ReadToEnd();
            process.StandardOutput.ReadToEnd();
            process.WaitForExit();
            if (process.ExitCode != 0) throw new Exception("tar payload fixture failed: " + stderr);
        }

        AssertTrue(SetupInstaller.HasOfflinePayload(install), "offline payload detected");
        SetupInstaller.EnsureOfflinePayload(install);
        AssertEqual("1.1.0-beta.4+offline.test", SetupInstaller.ValidateBundle(install), "payload expands into valid bundle");
        AssertTrue(File.Exists(Path.Combine(install, "cloudflared.exe")), "cloudflared expanded from payload");
        AssertTrue(File.Exists(Path.Combine(install, "runtime", "active-slot.txt")), "runtime pointer expanded from payload");
    }

    private static void TestModernPlan()
    {
        var root = TestRoot("modern");
        var settings = ManagedDevSpaceSettings.CreateDefault(root);
        var second = Path.Combine(root, "second");
        Directory.CreateDirectory(second);
        settings.AllowedRoots.Add(second);
        settings.ToolMode = "codex";

        var plan = DevSpaceConfiguration.BuildPlan(
            DevSpaceVersion.Parse("devspace 1.1.0-beta.1"),
            settings,
            Path.Combine(root, "managed-config"));
        DevSpaceConfiguration.WritePlan(plan);

        AssertEqual("config.jsonc", Path.GetFileName(plan.ConfigPath), "modern config filename");
        AssertEqual(4, plan.EnvironmentVariables.Count, "modern env count");
        AssertTrue(plan.EnvironmentVariables.ContainsKey("DEVSPACE_CONFIG_DIR"), "modern config dir env");
        AssertEqual(
            Path.Combine(Path.GetFullPath(settings.StateDir), "compact-runs"),
            plan.EnvironmentVariables["DEVSPACE_COMPACT_RUN_ROOT"],
            "compact output run root");
        AssertEqual("30", plan.EnvironmentVariables["DEVSPACE_COMPACT_LOG_RETENTION_DAYS"], "compact retention days");
        AssertEqual("2147483648", plan.EnvironmentVariables["DEVSPACE_COMPACT_LOG_MAX_BYTES"], "compact retention bytes");
        AssertTrue(!plan.EnvironmentVariables.ContainsKey("DEVSPACE_SUBAGENTS"), "removed env not emitted");
        AssertTrue(!plan.EnvironmentVariables.ContainsKey("DEVSPACE_TOOL_MODE"), "removed tool env not emitted");

        var json = ReadObject(plan.ConfigPath);
        var subagents = AsObject(json["subagents"]);
        var tools = AsObject(json["tools"]);
        var ui = AsObject(json["ui"]);
        var workspaces = AsObject(json["workspaces"]);
        var logging = AsObject(json["logging"]);

        AssertEqual(false, subagents["enabled"], "modern subagents disabled");
        AssertEqual("codex", tools["mode"], "modern tool mode");
        AssertEqual(true, ui["enabled"], "modern review ui");
        AssertEqual(2, ((object[])workspaces["allowedRoots"]).Length, "modern roots");
        AssertEqual(false, logging["shellCommands"], "shell log default");
    }

    private static void TestModernRejectsLegacyToolMode()
    {
        var root = TestRoot("invalid-mode");
        var settings = ManagedDevSpaceSettings.CreateDefault(root);
        settings.ToolMode = "minimal";
        AssertThrows<InvalidDataException>(delegate
        {
            DevSpaceConfiguration.BuildPlan(
                DevSpaceVersion.Parse("1.1.0"), settings, Path.Combine(root, "config"));
        });
    }

    private static void TestLegacySecurity()
    {
        var root = TestRoot("legacy-security");
        var settings = ManagedDevSpaceSettings.CreateDefault(root);
        settings.ToolMode = "codex";
        var plan = DevSpaceConfiguration.BuildPlan(
            DevSpaceVersion.Parse("1.0.8"), settings, Path.Combine(root, "config"));
        var report = DevSpaceEffectiveStateVerifier.Verify(plan, root);
        AssertTrue(report.IsSafe, "legacy security report");
    }

    private static void TestModernSecurity()
    {
        var root = TestRoot("modern-security");
        var settings = ManagedDevSpaceSettings.CreateDefault(root);
        var plan = DevSpaceConfiguration.BuildPlan(
            DevSpaceVersion.Parse("1.1.0"), settings, Path.Combine(root, "config"));
        var report = DevSpaceEffectiveStateVerifier.Verify(plan, root);
        AssertTrue(report.IsSafe, "modern security report");
    }

    private static void TestModernSecurityRejectsSubagents()
    {
        var root = TestRoot("modern-security-subagents");
        var settings = ManagedDevSpaceSettings.CreateDefault(root);
        var plan = DevSpaceConfiguration.BuildPlan(
            DevSpaceVersion.Parse("1.1.0"), settings, Path.Combine(root, "config"));
        plan.SerializedConfig = plan.SerializedConfig.Replace(
            "\"subagents\":{\"enabled\":false",
            "\"subagents\":{\"enabled\":true");
        var report = DevSpaceEffectiveStateVerifier.Verify(plan, root);
        AssertTrue(!report.IsSafe, "enabled subagents rejected");
    }

    private static void TestModernCliEnvironmentIsolation()
    {
        var node = FindNode();
        var root = TestRoot("modern-cli");
        var settings = ManagedDevSpaceSettings.CreateDefault(root);
        var plan = DevSpaceConfiguration.BuildPlan(
            DevSpaceVersion.Parse("1.1.0"), settings, Path.Combine(root, "config"));
        var fakeCli = Path.Combine(Environment.CurrentDirectory, "tests", "fake-devspace-cli.js");

        var previous = Environment.GetEnvironmentVariable("DEVSPACE_SUBAGENTS");
        try
        {
            Environment.SetEnvironmentVariable("DEVSPACE_SUBAGENTS", "1");
            var runner = new DevSpaceCliRunner(node, fakeCli, plan, root);
            var result = runner.Doctor();
            AssertTrue(result.Success, "modern fake CLI success");
            var json = ParseJson(result.StandardOutput);
            AssertEqual(null, json["subagents"], "modern inherited subagent env removed");
            AssertEqual(Path.GetFullPath(Path.Combine(root, "config")), json["configDir"], "modern managed config dir");
            AssertEqual("doctor", ((object[])json["args"])[0], "doctor arg");
        }
        finally
        {
            Environment.SetEnvironmentVariable("DEVSPACE_SUBAGENTS", previous);
        }
    }

    private static void TestLegacyCliEnvironment()
    {
        var node = FindNode();
        var root = TestRoot("legacy-cli");
        var settings = ManagedDevSpaceSettings.CreateDefault(root);
        settings.ToolMode = "minimal";
        var plan = DevSpaceConfiguration.BuildPlan(
            DevSpaceVersion.Parse("1.0.8"), settings, Path.Combine(root, "config"));
        var fakeCli = Path.Combine(Environment.CurrentDirectory, "tests", "fake-devspace-cli.js");
        var runner = new DevSpaceCliRunner(node, fakeCli, plan, root);
        var result = runner.ConfigGet();
        AssertTrue(result.Success, "legacy fake CLI success");
        var json = ParseJson(result.StandardOutput);
        AssertEqual("0", json["subagents"], "legacy subagent env");
        AssertEqual("minimal", json["toolMode"], "legacy tool env");
        AssertEqual("config", ((object[])json["args"])[0], "config arg");
        AssertEqual("get", ((object[])json["args"])[1], "get arg");
    }

    private static void TestRuntimeToolPath()
    {
        var root = TestRoot("runtime-tools");
        var serenaBin = Path.Combine(root, "runtime", "serena", "bin");
        var uvDir = Path.Combine(root, "runtime", "uv");
        Directory.CreateDirectory(serenaBin);
        Directory.CreateDirectory(uvDir);
        var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { "PATH", "C:\\ExistingTools" }
        };

        RuntimeResolver.AddRuntimeToolPaths(environment, root);
        var path = environment["PATH"];
        AssertTrue(path.StartsWith(serenaBin + Path.PathSeparator + uvDir + Path.PathSeparator, StringComparison.OrdinalIgnoreCase), "runtime tools precede inherited PATH");
        AssertTrue(path.EndsWith("C:\\ExistingTools", StringComparison.OrdinalIgnoreCase), "existing PATH retained");
    }

    private static void TestRuntimeSlotSelection()
    {
        var root = TestRoot("runtime-slot");
        var runtime = Path.Combine(root, "runtime");
        var slot = Path.Combine(runtime, "slots", "slot-a");
        var node = Path.Combine(slot, "node", "node.exe");
        var packageRoot = Path.Combine(slot, "devspace", "node_modules", "@waishnav", "devspace");
        var sharedSerena = Path.Combine(runtime, "serena", "bin");
        Directory.CreateDirectory(Path.GetDirectoryName(node));
        Directory.CreateDirectory(packageRoot);
        Directory.CreateDirectory(sharedSerena);
        File.WriteAllText(node, "test");
        File.WriteAllText(Path.Combine(packageRoot, "package.json"), "{\"version\":\"1.1.0-beta.3+local.7.win.1\"}");
        File.WriteAllText(Path.Combine(slot, "READY"), "ready");
        File.WriteAllText(Path.Combine(runtime, "active-slot.txt"), "slot-a");

        AssertEqual(Path.GetFullPath(node), RuntimeResolver.ResolveNodePath(root), "slot node path");
        AssertEqual(Path.GetFullPath(packageRoot), RuntimeResolver.ResolveDevSpacePackageRoot(root), "slot package root");
        AssertEqual("slot-a", RuntimeResolver.ActiveRuntimeSlot(root), "active slot name");
        AssertEqual(Path.GetFullPath(sharedSerena), RuntimeResolver.ResolveSerenaBinDirectory(root), "shared Serena remains visible outside slot");
    }

    private static void TestInvalidRuntimeSlotPointer()
    {
        var root = TestRoot("runtime-slot-invalid");
        var runtime = Path.Combine(root, "runtime");
        Directory.CreateDirectory(runtime);
        File.WriteAllText(Path.Combine(runtime, "active-slot.txt"), "..\\escape");
        AssertThrows<InvalidDataException>(delegate { RuntimeResolver.ActiveRuntimeSlot(root); });
    }

    private static void TestConfigurationHistory()
    {
        var root = TestRoot("history");
        var historyDir = Path.Combine(root, "history");
        var settingsPath = Path.Combine(root, "settings.json");
        var settings = PlatformSettings.CreateDefault(root);
        var version = DevSpaceVersion.Parse("1.1.0");
        PlatformSettingsStore.Save(settingsPath, settings);

        var history = new ConfigurationHistory(historyDir, 2);
        var first = history.Snapshot(settingsPath, version);
        System.Threading.Thread.Sleep(20);
        settings.LogLevel = "debug";
        PlatformSettingsStore.Save(settingsPath, settings);
        history.Snapshot(settingsPath, version);
        System.Threading.Thread.Sleep(20);
        settings.LogLevel = "warn";
        PlatformSettingsStore.Save(settingsPath, settings);
        var latest = history.Snapshot(settingsPath, version);

        var files = history.ListNewestFirst();
        AssertEqual(2, files.Count, "history bounded count");
        AssertTrue(!File.Exists(first), "oldest history trimmed");
        var loaded = history.Load(latest);
        var restored = PlatformSettingsStore.Deserialize(loaded.SettingsText);
        AssertEqual("warn", restored.LogLevel, "history settings content");
        AssertTrue(loaded.SettingsText.IndexOf("ownerToken", StringComparison.OrdinalIgnoreCase) < 0, "history contains no owner token");
    }

    private static void TestLegacyQuickConfigMigration()
    {
        var root = TestRoot("legacy-import");
        var workspace = Path.Combine(root, "workspace");
        Directory.CreateDirectory(workspace);
        var legacyPath = Path.Combine(root, "settings.json");
        File.WriteAllText(legacyPath,
            "{\"SchemaVersion\":1,\"WorkspaceRoot\":" + Quote(workspace) +
            ",\"ToolMode\":\"codex\",\"LocalPort\":7788,\"TunnelMode\":\"Named\"," +
            "\"FixedHostname\":\"example.test\",\"NamedTunnelIdOrName\":\"tunnel-id\"," +
            "\"CredentialsFilePath\":\"cred.json\",\"CloudflaredConfigPath\":\"cloud.yml\"," +
            "\"AutoStart\":true,\"IsNamedTunnel\":true}");

        var imported = LegacyQuickConfigImporter.Import(legacyPath, root, DevSpaceVersion.Parse("1.1.0"));
        AssertEqual(1, imported.Settings.AllowedRoots.Count, "migrated roots");
        AssertEqual(Path.GetFullPath(workspace), imported.Settings.AllowedRoots[0], "migrated workspace");
        AssertEqual("codex", imported.Settings.ToolMode, "migrated tool mode");
        AssertEqual(7788, imported.Settings.LocalPort, "migrated port");
        AssertEqual("Named", imported.Settings.TunnelMode, "migrated tunnel mode");
        AssertEqual(true, imported.Settings.AutoStart, "migrated autostart");
        AssertEqual(false, imported.Settings.LogShellCommands, "new safe default retained");
    }

    private static void TestLegacyToolModeMigration()
    {
        var root = TestRoot("legacy-mode-import");
        var workspace = Path.Combine(root, "workspace");
        Directory.CreateDirectory(workspace);
        var legacyPath = Path.Combine(root, "settings.json");
        File.WriteAllText(legacyPath,
            "{\"SchemaVersion\":1,\"WorkspaceRoot\":" + Quote(workspace) +
            ",\"ToolMode\":\"minimal\",\"LocalPort\":7676,\"TunnelMode\":\"Quick\"}");
        var imported = LegacyQuickConfigImporter.Import(legacyPath, root, DevSpaceVersion.Parse("1.1.0"));
        AssertEqual("claude", imported.Settings.ToolMode, "modern tool mode mapping");
        AssertTrue(imported.Notes.Count > 0, "mapping note exists");
    }

    private static void TestReviewRollback()
    {
        var root = TestRoot("review-rollback");
        Git(root, "init");
        Git(root, "config user.name Test");
        Git(root, "config user.email test@local.invalid");
        File.WriteAllText(Path.Combine(root, "file.txt"), "before\n");
        Git(root, "add -A");
        Git(root, "commit -m baseline");
        DevSpaceReviewRollback.ObserveWorkspaceOpen(root);

        File.WriteAllText(Path.Combine(root, "file.txt"), "after-one\n");
        File.WriteAllText(Path.Combine(root, "one.txt"), "one\n");
        AssertTrue(DevSpaceReviewRollback.RecordReview(root, null), "first review snapshot recorded");

        File.WriteAllText(Path.Combine(root, "file.txt"), "after-two\n");
        File.WriteAllText(Path.Combine(root, "two.txt"), "two\n");
        AssertTrue(DevSpaceReviewRollback.RecordReview(root, null), "second review snapshot recorded");

        var history = DevSpaceReviewRollback.ListVersions(root);
        AssertEqual(3, history.Versions.Count, "baseline plus two review versions");
        var current = history.Versions.Single(v => v.IsCurrent);
        AssertEqual("V2", current.Version, "latest version label");
        Git(root, "notes --ref=devspace-control-platform add -f -m \"窗口放大后版本表过宽；限制列表宽度并保持摘要简洁。\" " + current.ReviewRef);
        history = DevSpaceReviewRollback.ListVersions(root);
        current = history.Versions.Single(v => v.IsCurrent);
        AssertEqual("窗口放大后版本表过宽；限制列表宽度并保持摘要简洁。", current.Summary, "UTF-8 review summary round trips");
        var longSummary = new string('x', 90);
        Git(root, "notes --ref=devspace-control-platform add -f -m " + longSummary + " " + current.ReviewRef);
        history = DevSpaceReviewRollback.ListVersions(root);
        current = history.Versions.Single(v => v.IsCurrent);
        AssertEqual(longSummary, current.Summary, "review summary is preserved without truncation");
        var baseline = history.Versions.Single(v => v.IsBaseline);
        var rolledBack = DevSpaceReviewRollback.RollbackTo(root, baseline.ReviewRef);
        AssertEqual(2, rolledBack.RolledBackReviews, "multi-version rollback count");
        AssertEqual("before\n", File.ReadAllText(Path.Combine(root, "file.txt")).Replace("\r\n", "\n"), "tracked file restored");
        AssertTrue(!File.Exists(Path.Combine(root, "one.txt")), "earlier review-added file removed");
        AssertTrue(!File.Exists(Path.Combine(root, "two.txt")), "latest review-added file removed");

        history = DevSpaceReviewRollback.ListVersions(root);
        AssertTrue(history.Versions.Count >= 3, "rolled-back branch retained for audit");
        AssertTrue(history.Versions.Single(v => v.IsBaseline).IsCurrent, "baseline is current after rollback");
        AssertEqual(2, history.Versions.Count(v => !v.IsActive), "rolled-back versions marked inactive");

        File.WriteAllText(Path.Combine(root, "branch.txt"), "branch\n");
        AssertTrue(DevSpaceReviewRollback.RecordReview(root, null), "new branch review recorded");
        history = DevSpaceReviewRollback.ListVersions(root);
        AssertEqual("V3", history.Versions.Single(v => v.IsCurrent).Version, "version numbers remain monotonic after rollback branch");
        AssertEqual(4, history.Versions.Count, "old branch and new version all retained");
    }

    private static void TestRollbackNotice()
    {
        var root = TestRoot("rollback-notice");
        var workspace = Path.Combine(root, "workspace");
        Directory.CreateDirectory(workspace);
        var target = new DevSpaceReviewVersion
        {
            Version = "V4",
            ReviewRef = "abc123",
            CreatedAt = DateTimeOffset.Now,
            Summary = "修复配置与日志布局"
        };
        ManagedAgentInstructions.SetRollbackNotice(root, workspace, target, 3);
        var instructions = Path.Combine(root, "state", "agent-home", "AGENTS.md");
        var text = File.ReadAllText(instructions);
        AssertTrue(text.IndexOf("V4", StringComparison.Ordinal) >= 0, "rollback version injected");
        AssertTrue(text.IndexOf("git notes --ref=devspace-control-platform", StringComparison.Ordinal) >= 0, "GPT summary instruction present");
        AssertTrue(text.IndexOf("问题/动机；处理结果", StringComparison.Ordinal) >= 0, "GPT summary requires reason and result");
        AssertTrue(text.IndexOf("never invent one", StringComparison.Ordinal) >= 0, "GPT summary must not invent root cause");
        AssertTrue(text.IndexOf("Project ownership and local Git", StringComparison.Ordinal) >= 0, "project ownership instruction present");
        AssertTrue(text.IndexOf("git rev-parse --show-toplevel", StringComparison.Ordinal) >= 0, "canonical Git root instruction present");
        AssertTrue(text.IndexOf("Do not push automatically", StringComparison.Ordinal) >= 0, "managed instructions prohibit automatic push");
        AssertTrue(!ManagedAgentInstructions.ConsumeRollbackNoticeIfMatches(root, Path.Combine(root, "other")), "unrelated workspace does not consume notice");
        AssertTrue(ManagedAgentInstructions.ConsumeRollbackNoticeIfMatches(root, workspace), "matching workspace consumes notice");
        text = File.ReadAllText(instructions);
        AssertTrue(text.IndexOf("One-time rollback notice", StringComparison.Ordinal) < 0, "rollback notice removed after consumption");
    }

    private static void TestConversationLogIsolation()
    {
        var root = TestRoot("conversation-logs");
        var store = new ConversationLogStore(root, 20);
        store.Add("ws_chat_a", "DevSpace", "tool_call tool=\"read\" workspaceId=\"ws_chat_a\"");
        store.Add("ws_chat_b", "DevSpace", "tool_call tool=\"apply_patch\" workspaceId=\"ws_chat_b\"");

        var a = store.ReadRecent("ws_chat_a");
        var b = store.ReadRecent("ws_chat_b");
        AssertTrue(a.IndexOf("read", StringComparison.Ordinal) >= 0, "conversation A contains its own call");
        AssertTrue(a.IndexOf("apply_patch", StringComparison.Ordinal) < 0, "conversation A excludes conversation B");
        AssertTrue(b.IndexOf("apply_patch", StringComparison.Ordinal) >= 0, "conversation B contains its own call");
        AssertTrue(b.IndexOf("tool=\"read\"", StringComparison.Ordinal) < 0, "conversation B excludes conversation A");
        AssertEqual(2, store.KnownWorkspaceIds.Length, "two isolated conversation log files");
    }

    private static void TestIndependentProjectReviewHistories()
    {
        var projectA = TestRoot("review-project-a");
        var projectB = TestRoot("review-project-b");
        foreach (var root in new[] { projectA, projectB })
        {
            Git(root, "init");
            Git(root, "config user.name Test");
            Git(root, "config user.email test@local.invalid");
            File.WriteAllText(Path.Combine(root, "file.txt"), "baseline\n");
            Git(root, "add -A");
            Git(root, "commit -m baseline");
            DevSpaceReviewRollback.ObserveWorkspaceOpen(root);
        }

        File.WriteAllText(Path.Combine(projectA, "file.txt"), "project-a-v1\n");
        File.WriteAllText(Path.Combine(projectB, "file.txt"), "project-b-v1\n");
        AssertTrue(DevSpaceReviewRollback.RecordReview(projectA, null), "project A review recorded");
        AssertTrue(DevSpaceReviewRollback.RecordReview(projectB, null), "project B review recorded");

        var historyA = DevSpaceReviewRollback.ListVersions(projectA);
        var historyB = DevSpaceReviewRollback.ListVersions(projectB);
        AssertEqual("V1", historyA.Versions.Single(v => v.IsCurrent).Version, "project A has independent V1");
        AssertEqual("V1", historyB.Versions.Single(v => v.IsCurrent).Version, "project B has independent V1");

        DevSpaceReviewRollback.RollbackTo(projectA, historyA.Versions.Single(v => v.IsBaseline).ReviewRef);
        historyB = DevSpaceReviewRollback.ListVersions(projectB);
        AssertEqual("V1", historyB.Versions.Single(v => v.IsCurrent).Version, "rolling back A leaves B untouched");
        AssertEqual("project-b-v1\n", File.ReadAllText(Path.Combine(projectB, "file.txt")).Replace("\r\n", "\n"), "project B files untouched");
    }

    private static void TestNonGitWorkspaceInitialization()
    {
        var root = Path.Combine(Path.GetTempPath(), "devspace-control-non-git-review-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        File.WriteAllText(Path.Combine(root, "file.txt"), "baseline\n");
        AssertEqual(Path.GetFullPath(root), DevSpaceReviewRollback.EnsureRepository(root), "initialized repository root");
        AssertTrue(Directory.Exists(Path.Combine(root, ".git")), "local git metadata created");
        DevSpaceReviewRollback.ObserveWorkspaceOpen(root);
        var history = DevSpaceReviewRollback.ListVersions(root);
        AssertEqual(1, history.Versions.Count, "initial working tree captured as V0");
        AssertTrue(history.Versions.Single().IsBaseline, "initial version is baseline");
        AssertEqual("baseline\n", File.ReadAllText(Path.Combine(root, "file.txt")).Replace("\r\n", "\n"), "business file unchanged");
    }

    private static void TestProjectRepositoryIdentity()
    {
        var root = TestRoot("project-identity");
        var nested = Path.Combine(root, "src", "feature");
        Directory.CreateDirectory(nested);
        Git(root, "init");
        Git(root, "config user.name Test");
        Git(root, "config user.email test@local.invalid");
        File.WriteAllText(Path.Combine(root, "README.md"), "baseline\n");
        Git(root, "add -A");
        Git(root, "commit -m baseline");

        string repositoryRoot;
        AssertTrue(DevSpaceReviewRollback.TryRepositoryRoot(nested, out repositoryRoot), "nested workspace resolves existing repository");
        AssertEqual(Path.GetFullPath(root), repositoryRoot, "nested workspace maps to canonical Git root");

        var info = DevSpaceReviewRollback.DescribeRepository(nested);
        AssertTrue(info.IsRepository, "repository identity detected");
        AssertEqual(Path.GetFileName(root), info.Name, "repository display name");
        AssertEqual(1, info.CommitCount, "real Git commit count");
        AssertEqual("baseline", info.HeadSummary, "real Git HEAD summary");
        AssertTrue(!info.IsDirty, "clean repository reported clean");
        AssertEqual(1, DevSpaceReviewRollback.ListRecentCommits(nested, 12).Count, "recent Git commits exposed");

        File.WriteAllText(Path.Combine(root, "dirty.txt"), "dirty\n");
        info = DevSpaceReviewRollback.DescribeRepository(nested);
        AssertTrue(info.IsDirty, "working tree changes reported dirty");

        var nonGit = Path.Combine(Path.GetTempPath(), "devspace-control-project-identity-no-git-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(nonGit);
        info = DevSpaceReviewRollback.DescribeRepository(nonGit);
        AssertTrue(!info.IsRepository, "non-Git workspace remains unowned until model initializes repository");
    }

    private static void TestUnbornRepositoryReviewHistory()
    {
        var root = TestRoot("unborn-review");
        Git(root, "init");
        File.WriteAllText(Path.Combine(root, "file.txt"), "baseline\n");

        DevSpaceReviewRollback.ObserveWorkspaceOpen(root);
        var history = DevSpaceReviewRollback.ListVersions(root);
        AssertEqual(1, history.Versions.Count, "unborn repository gets hidden V0 baseline");
        AssertTrue(history.Versions.Single().IsBaseline, "unborn V0 is baseline");

        File.WriteAllText(Path.Combine(root, "file.txt"), "changed\n");
        AssertTrue(DevSpaceReviewRollback.RecordReview(root, "ws_unborn"), "unborn repository records V1 without a real branch commit");
        history = DevSpaceReviewRollback.ListVersions(root);
        AssertEqual("V1", history.Versions.Single(v => v.IsCurrent).Version, "unborn repository advances hidden review chain");

        var headCheck = new ProcessStartInfo
        {
            FileName = "git",
            Arguments = "rev-parse --verify HEAD",
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        using (var process = Process.Start(headCheck))
        {
            process.WaitForExit();
            AssertTrue(process.ExitCode != 0, "ControlPlatform hidden review does not create a real branch commit");
        }
    }

    private static string Git(string workingDirectory, string arguments)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = "git",
            Arguments = arguments,
            WorkingDirectory = workingDirectory,
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
            if (process.ExitCode != 0) throw new Exception("git " + arguments + " failed: " + stderr);
            return stdout;
        }
    }

    private static string Quote(string value)
    {
        return new JavaScriptSerializer().Serialize(value);
    }

    private static string TestRoot(string name)
    {
        var root = Path.Combine(
            Environment.CurrentDirectory,
            ".test-output",
            name + "-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static Dictionary<string, object> ReadObject(string path)
    {
        var serializer = new JavaScriptSerializer();
        return (Dictionary<string, object>)serializer.DeserializeObject(File.ReadAllText(path));
    }

    private static Dictionary<string, object> ParseJson(string json)
    {
        var serializer = new JavaScriptSerializer();
        return (Dictionary<string, object>)serializer.DeserializeObject(json);
    }

    private static string FindNode()
    {
        var candidates = new List<string>();
        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        if (!string.IsNullOrWhiteSpace(programFiles))
        {
            candidates.Add(Path.Combine(programFiles, "nodejs", "node.exe"));
        }
        var path = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (var directory in path.Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(directory))
            {
                candidates.Add(Path.Combine(directory.Trim(), "node.exe"));
            }
        }
        foreach (var candidate in candidates)
        {
            if (File.Exists(candidate)) return candidate;
        }
        throw new FileNotFoundException("Tests require node.exe on PATH or under Program Files\\nodejs.");
    }

    private static Dictionary<string, object> AsObject(object value)
    {
        return (Dictionary<string, object>)value;
    }

    private static void Run(string name, Action test)
    {
        try
        {
            test();
            Console.WriteLine("PASS " + name);
        }
        catch (Exception exception)
        {
            failures++;
            Console.Error.WriteLine("FAIL " + name + ": " + exception.Message);
        }
    }

    private static void AssertTrue(bool value, string name)
    {
        if (!value) throw new Exception(name + " expected true");
    }

    private static void AssertEqual(object expected, object actual, string name)
    {
        if (!object.Equals(expected, actual))
        {
            throw new Exception(name + " expected " + expected + ", got " + actual);
        }
    }

    private static void AssertThrows<T>(Action action) where T : Exception
    {
        try
        {
            action();
        }
        catch (T)
        {
            return;
        }
        throw new Exception("Expected " + typeof(T).Name);
    }
}
