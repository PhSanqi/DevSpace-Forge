using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;

namespace DevSpaceControlPlatform
{
    internal sealed class DevSpaceReviewVersion
    {
        public string Version { get; set; }
        public string ReviewRef { get; set; }
        public string ParentRef { get; set; }
        public DateTimeOffset CreatedAt { get; set; }
        public string Summary { get; set; }
        public bool IsCurrent { get; set; }
        public bool IsActive { get; set; }
        public bool IsBaseline { get; set; }
        public int RollbackSteps { get; set; }

        public string Status
        {
            get { return IsCurrent ? "当前" : IsActive ? "可回滚" : "已回滚"; }
        }
    }

    internal sealed class DevSpaceReviewHistory
    {
        public string WorkspacePath { get; set; }
        public List<DevSpaceReviewVersion> Versions { get; set; }
    }

    internal sealed class DevSpaceReviewRollbackResult
    {
        public DevSpaceReviewVersion Target { get; set; }
        public int RolledBackReviews { get; set; }
        public string Message { get; set; }
    }

    internal static class DevSpaceReviewRollback
    {
        private const string BaseRef = "refs/devspace/control-platform/history/base";
        private const string HeadRef = "refs/devspace/control-platform/history/head";
        private const string VersionPrefix = "refs/devspace/control-platform/versions/";

        public static string RepositoryRoot(string workspacePath)
        {
            if (string.IsNullOrWhiteSpace(workspacePath) || !Directory.Exists(workspacePath))
                throw new DirectoryNotFoundException("DevSpace workspace 不存在：" + workspacePath);
            var root = RequireGit(workspacePath, "rev-parse --show-toplevel", null, null).StandardOutput.Trim();
            return Path.GetFullPath(root);
        }

        public static void ObserveWorkspaceOpen(string workspacePath)
        {
            ValidateRepository(workspacePath);
            var head = ResolveCommit(workspacePath, HeadRef);
            if (string.IsNullOrWhiteSpace(head))
            {
                var baseline = CreateWorkingTreeSnapshot(workspacePath, ResolveHead(workspacePath), "ControlPlatform workspace baseline");
                UpdateRef(workspacePath, BaseRef, baseline, null);
                UpdateRef(workspacePath, HeadRef, baseline, null);
                CreateVersionRef(workspacePath, baseline, 0);
                WriteSummaryNote(workspacePath, baseline, "Workspace 初始基线");
                return;
            }

            var snapshot = CreateWorkingTreeSnapshot(workspacePath, head, "ControlPlatform workspace-open snapshot");
            if (HasDiff(workspacePath, head, snapshot))
            {
                UpdateRef(workspacePath, HeadRef, snapshot, head);
                CreateVersionRef(workspacePath, snapshot, NextVersionNumber(workspacePath));
                WriteSummaryNote(workspacePath, snapshot, "打开 workspace 时检测到外部修改");
            }
        }

        public static bool RecordReview(string workspacePath, string workspaceId)
        {
            ValidateRepository(workspacePath);
            var head = ResolveCommit(workspacePath, HeadRef);
            if (string.IsNullOrWhiteSpace(head))
            {
                ObserveWorkspaceOpen(workspacePath);
                head = ResolveCommit(workspacePath, HeadRef);
            }

            var snapshot = CreateWorkingTreeSnapshot(workspacePath, head, "ControlPlatform review snapshot");
            if (!HasDiff(workspacePath, head, snapshot)) return false;
            UpdateRef(workspacePath, HeadRef, snapshot, head);
            CreateVersionRef(workspacePath, snapshot, NextVersionNumber(workspacePath));
            if (!string.IsNullOrWhiteSpace(workspaceId))
            {
                var sourceReview = ResolveCommit(workspacePath, "refs/devspace/review/" + workspaceId + "/baseline");
                if (!string.IsNullOrWhiteSpace(sourceReview))
                    UpdateRef(workspacePath, "refs/devspace/control-platform/source/" + snapshot, sourceReview, null);
            }
            return true;
        }

        public static DevSpaceReviewHistory ListVersions(string workspacePath)
        {
            ValidateRepository(workspacePath);
            var baseCommit = ResolveCommit(workspacePath, BaseRef);
            var currentCommit = ResolveCommit(workspacePath, HeadRef);
            if (string.IsNullOrWhiteSpace(baseCommit) || string.IsNullOrWhiteSpace(currentCommit))
            {
                return new DevSpaceReviewHistory
                {
                    WorkspacePath = workspacePath,
                    Versions = new List<DevSpaceReviewVersion>()
                };
            }

            var activeChain = BuildChain(workspacePath, currentCommit, baseCommit);
            var ordered = ListVersionRefs(workspacePath);
            var activeIndexes = activeChain
                .Select((commit, index) => new CommitIndex { Commit = commit, Index = index })
                .ToDictionary(item => item.Commit, item => item.Index, StringComparer.OrdinalIgnoreCase);
            var versions = new List<DevSpaceReviewVersion>();
            foreach (var item in ordered)
            {
                var commit = item.Commit;
                var isBase = string.Equals(commit, baseCommit, StringComparison.OrdinalIgnoreCase);
                var parent = isBase ? string.Empty : ParentCommit(workspacePath, commit);
                int activeIndex;
                var active = activeIndexes.TryGetValue(commit, out activeIndex);
                versions.Add(new DevSpaceReviewVersion
                {
                    Version = "V" + item.Number,
                    ReviewRef = commit,
                    ParentRef = parent,
                    CreatedAt = CommitTime(workspacePath, commit),
                    Summary = isBase ? "Workspace 初始基线" : ReviewSummary(workspacePath, parent, commit),
                    IsCurrent = string.Equals(commit, currentCommit, StringComparison.OrdinalIgnoreCase),
                    IsActive = active,
                    IsBaseline = isBase,
                    RollbackSteps = active ? activeChain.Count - 1 - activeIndex : 0
                });
            }
            return new DevSpaceReviewHistory { WorkspacePath = workspacePath, Versions = versions };
        }

        public static DevSpaceReviewRollbackResult RollbackTo(string workspacePath, string targetReviewRef)
        {
            var history = ListVersions(workspacePath);
            var current = history.Versions.FirstOrDefault(v => v.IsCurrent);
            var target = history.Versions.FirstOrDefault(v =>
                string.Equals(v.ReviewRef, targetReviewRef, StringComparison.OrdinalIgnoreCase));
            if (current == null || target == null)
                throw new InvalidOperationException("无法解析当前或目标代码版本。");
            if (!target.IsActive)
                throw new InvalidOperationException("所选版本属于已经回滚的旧分支；当前只允许向更早的活动版本回滚。");
            if (target.IsCurrent) throw new InvalidOperationException("所选版本已经是当前版本。");
            if (target.RollbackSteps <= current.RollbackSteps)
                throw new InvalidOperationException("所选版本不是当前版本之前的版本。");

            var steps = target.RollbackSteps - current.RollbackSteps;
            var patchResult = RunGit(
                workspacePath,
                "diff --binary --no-color " + target.ReviewRef + " " + current.ReviewRef,
                null,
                null);
            if (patchResult.ExitCode != 0)
                throw new InvalidOperationException("无法生成目标版本的反向补丁：" + patchResult.StandardError.Trim());
            var patch = patchResult.StandardOutput;
            if (string.IsNullOrWhiteSpace(patch)) throw new InvalidOperationException("当前版本与目标版本没有可回滚内容。");

            var check = RunGit(workspacePath, "apply --check --reverse --whitespace=nowarn -", patch, null);
            if (check.ExitCode != 0)
            {
                throw new InvalidOperationException(
                    "当前文件在最近版本之后继续变化，回滚可能覆盖后续修改，因此已拒绝。\r\n" +
                    check.StandardError.Trim());
            }

            var apply = RunGit(workspacePath, "apply --reverse --whitespace=nowarn -", patch, null);
            if (apply.ExitCode != 0) throw new InvalidOperationException("回滚失败：" + apply.StandardError.Trim());

            try
            {
                UpdateRef(workspacePath, HeadRef, target.ReviewRef, current.ReviewRef);
            }
            catch
            {
                var restore = RunGit(workspacePath, "apply --check --whitespace=nowarn -", patch, null);
                if (restore.ExitCode == 0) RunGit(workspacePath, "apply --whitespace=nowarn -", patch, null);
                throw;
            }

            return new DevSpaceReviewRollbackResult
            {
                Target = target,
                RolledBackReviews = steps,
                Message = "已一次回滚 " + steps + " 个版本到 " + target.Version + "：" + target.Summary + "。"
            };
        }

        private static string CreateWorkingTreeSnapshot(string workspacePath, string parent, string message)
        {
            var tempDirectory = Path.Combine(Path.GetTempPath(), "devspace-control-review-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDirectory);
            var indexPath = Path.Combine(tempDirectory, "index");
            var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                { "GIT_INDEX_FILE", indexPath }
            };
            try
            {
                RequireGit(workspacePath, "read-tree HEAD", null, environment);
                RequireGit(workspacePath, "add -A -- .", null, environment);
                var tree = RequireGit(workspacePath, "write-tree", null, environment).StandardOutput.Trim();
                return RequireGit(
                    workspacePath,
                    "-c user.name=DevSpaceControlPlatform -c user.email=control@local.invalid commit-tree " +
                    tree + " -p " + parent + " -m \"" + message.Replace("\"", string.Empty) + "\"",
                    null,
                    null).StandardOutput.Trim();
            }
            finally
            {
                try { Directory.Delete(tempDirectory, true); }
                catch { }
            }
        }

        private static void ValidateRepository(string workspacePath)
        {
            RepositoryRoot(workspacePath);
            RequireGit(workspacePath, "rev-parse --verify HEAD^{commit}", null, null);
        }

        private static string ResolveHead(string workspacePath)
        {
            return RequireGit(workspacePath, "rev-parse --verify HEAD^{commit}", null, null).StandardOutput.Trim();
        }

        private static bool HasDiff(string workspacePath, string before, string after)
        {
            var diff = RunGit(workspacePath, "diff --quiet " + before + " " + after, null, null);
            if (diff.ExitCode == 0) return false;
            if (diff.ExitCode == 1) return true;
            throw new InvalidOperationException("无法比较代码版本：" + diff.StandardError.Trim());
        }

        private static void UpdateRef(string workspacePath, string refName, string value, string expectedOld)
        {
            var command = "update-ref \"" + refName + "\" " + value +
                (string.IsNullOrWhiteSpace(expectedOld) ? string.Empty : " " + expectedOld);
            RequireGit(workspacePath, command, null, null);
        }

        private static void WriteSummaryNote(string workspacePath, string commit, string summary)
        {
            var temporaryPath = Path.Combine(Path.GetTempPath(), "devspace-control-summary-" + Guid.NewGuid().ToString("N") + ".txt");
            try
            {
                File.WriteAllText(temporaryPath, CompactSummary(summary) + Environment.NewLine, new UTF8Encoding(false));
                RunGit(
                    workspacePath,
                    "notes --ref=devspace-control-platform add -f -F \"" + temporaryPath + "\" " + commit,
                    null,
                    null);
            }
            finally
            {
                try { File.Delete(temporaryPath); }
                catch { }
            }
        }

        private static int NextVersionNumber(string workspacePath)
        {
            var versions = ListVersionRefs(workspacePath);
            return versions.Count == 0 ? 0 : versions.Max(v => v.Number) + 1;
        }

        private static void CreateVersionRef(string workspacePath, string commit, int number)
        {
            UpdateRef(workspacePath, VersionPrefix + "V" + number.ToString("D4"), commit, null);
        }

        private static List<VersionRef> ListVersionRefs(string workspacePath)
        {
            var result = RunGit(
                workspacePath,
                "for-each-ref --format=\"%(refname) %(objectname)\" \"" + VersionPrefix + "\"",
                null,
                null);
            if (result.ExitCode != 0) return new List<VersionRef>();
            var values = new List<VersionRef>();
            foreach (var line in SplitLines(result.StandardOutput))
            {
                var space = line.IndexOf(' ');
                if (space <= 0) continue;
                var refName = line.Substring(0, space).Trim();
                var commit = line.Substring(space + 1).Trim();
                var leaf = refName.Substring(refName.LastIndexOf('/') + 1);
                int number;
                if (!leaf.StartsWith("V", StringComparison.OrdinalIgnoreCase) ||
                    !int.TryParse(leaf.Substring(1), out number)) continue;
                values.Add(new VersionRef { Number = number, Commit = commit });
            }
            return values.OrderBy(v => v.Number).ToList();
        }

        private static List<string> BuildChain(string workspacePath, string head, string baseCommit)
        {
            var reverse = new List<string>();
            var cursor = head;
            for (var guard = 0; guard < 1000 && !string.IsNullOrWhiteSpace(cursor); guard++)
            {
                reverse.Add(cursor);
                if (string.Equals(cursor, baseCommit, StringComparison.OrdinalIgnoreCase)) break;
                cursor = ParentCommit(workspacePath, cursor);
            }
            if (reverse.Count == 0 || !string.Equals(reverse[reverse.Count - 1], baseCommit, StringComparison.OrdinalIgnoreCase))
                return new List<string>();
            reverse.Reverse();
            return reverse;
        }

        private static string ResolveCommit(string workspacePath, string refName)
        {
            var result = RunGit(workspacePath, "rev-parse --verify \"" + refName + "^{commit}\"", null, null);
            return result.ExitCode == 0 ? result.StandardOutput.Trim() : string.Empty;
        }

        private static string ParentCommit(string workspacePath, string commit)
        {
            var result = RunGit(workspacePath, "rev-parse --verify \"" + commit + "^1\"", null, null);
            return result.ExitCode == 0 ? result.StandardOutput.Trim() : string.Empty;
        }

        private static DateTimeOffset CommitTime(string workspacePath, string commit)
        {
            var result = RunGit(workspacePath, "show -s --format=%cI " + commit, null, null);
            DateTimeOffset parsed;
            return result.ExitCode == 0 && DateTimeOffset.TryParse(result.StandardOutput.Trim(), out parsed)
                ? parsed
                : DateTimeOffset.MinValue;
        }

        private static string ReviewSummary(string workspacePath, string parent, string commit)
        {
            var note = RunGit(workspacePath, "notes --ref=devspace-control-platform show " + commit, null, null);
            if (note.ExitCode == 0 && !string.IsNullOrWhiteSpace(note.StandardOutput)) return CompactSummary(note.StandardOutput);

            var sourceReview = ResolveCommit(workspacePath, "refs/devspace/control-platform/source/" + commit);
            if (!string.IsNullOrWhiteSpace(sourceReview))
            {
                var sourceNote = RunGit(workspacePath, "notes --ref=devspace-control-platform show " + sourceReview, null, null);
                if (sourceNote.ExitCode == 0 && !string.IsNullOrWhiteSpace(sourceNote.StandardOutput))
                    return CompactSummary(sourceNote.StandardOutput);
            }

            var numstat = RunGit(workspacePath, "diff --numstat " + parent + " " + commit, null, null);
            var names = RunGit(workspacePath, "diff --name-only " + parent + " " + commit, null, null);
            var fileNames = SplitLines(names.StandardOutput).Where(v => !string.IsNullOrWhiteSpace(v)).ToList();
            var additions = 0;
            var removals = 0;
            foreach (var line in SplitLines(numstat.StandardOutput))
            {
                var parts = line.Split('\t');
                int value;
                if (parts.Length > 1 && int.TryParse(parts[0], out value)) additions += value;
                if (parts.Length > 1 && int.TryParse(parts[1], out value)) removals += value;
            }
            var examples = string.Join("、", fileNames.Take(3).Select(Path.GetFileName).ToArray());
            if (fileNames.Count > 3) examples += " 等";
            return CompactSummary("未收到原因摘要；修改 " + fileNames.Count + " 个文件" +
                (examples.Length > 0 ? "：" + examples : string.Empty) +
                "（+" + additions + "/-" + removals + "）");
        }

        private static string CompactSummary(string value)
        {
            return string.Join(" ", (value ?? string.Empty)
                .Replace("\r", " ")
                .Replace("\n", " ")
                .Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries));
        }

        private static IEnumerable<string> SplitLines(string value)
        {
            return (value ?? string.Empty)
                .Replace("\r", string.Empty)
                .Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries);
        }

        private static GitResult RequireGit(
            string workingDirectory,
            string arguments,
            string standardInput,
            IDictionary<string, string> environment)
        {
            var result = RunGit(workingDirectory, arguments, standardInput, environment);
            if (result.ExitCode != 0)
                throw new InvalidOperationException("git " + arguments + " 失败：" + result.StandardError.Trim());
            return result;
        }

        private static GitResult RunGit(
            string workingDirectory,
            string arguments,
            string standardInput,
            IDictionary<string, string> environment)
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = "git",
                Arguments = arguments,
                WorkingDirectory = Path.GetFullPath(workingDirectory),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = standardInput != null,
                StandardOutputEncoding = new UTF8Encoding(false),
                StandardErrorEncoding = new UTF8Encoding(false)
            };
            if (environment != null)
            {
                foreach (var pair in environment) startInfo.EnvironmentVariables[pair.Key] = pair.Value;
            }
            using (var process = new Process { StartInfo = startInfo })
            {
                process.Start();
                if (standardInput != null)
                {
                    process.StandardInput.Write(standardInput);
                    process.StandardInput.Close();
                }
                var stdout = process.StandardOutput.ReadToEnd();
                var stderr = process.StandardError.ReadToEnd();
                process.WaitForExit();
                return new GitResult { ExitCode = process.ExitCode, StandardOutput = stdout, StandardError = stderr };
            }
        }

        private sealed class CommitIndex
        {
            public string Commit { get; set; }
            public int Index { get; set; }
        }

        private sealed class VersionRef
        {
            public int Number { get; set; }
            public string Commit { get; set; }
        }

        private sealed class GitResult
        {
            public int ExitCode { get; set; }
            public string StandardOutput { get; set; }
            public string StandardError { get; set; }
        }
    }
}
