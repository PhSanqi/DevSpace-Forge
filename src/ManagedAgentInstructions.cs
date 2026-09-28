using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace DevSpaceControlPlatform
{
    internal static class ManagedAgentInstructions
    {
        private const int SchemaVersion = 1;

        public static void Ensure(string platformRoot)
        {
            WriteInstructions(platformRoot, LoadNotice(platformRoot));
        }

        public static void SetRollbackNotice(
            string platformRoot,
            string workspacePath,
            DevSpaceReviewVersion target,
            int rolledBackReviews)
        {
            if (target == null) throw new ArgumentNullException("target");
            var notice = new Dictionary<string, object>
            {
                { "schemaVersion", SchemaVersion },
                { "workspacePath", Path.GetFullPath(workspacePath) },
                { "version", target.Version },
                { "reviewRef", target.ReviewRef },
                { "createdAt", target.CreatedAt.ToString("o") },
                { "summary", target.Summary ?? string.Empty },
                { "rolledBackReviews", rolledBackReviews }
            };
            var directory = AgentDirectory(platformRoot);
            Directory.CreateDirectory(directory);
            File.WriteAllText(
                NoticePath(platformRoot),
                new JavaScriptSerializer().Serialize(notice) + Environment.NewLine,
                new UTF8Encoding(false));
            WriteInstructions(platformRoot, notice);
        }

        public static bool ConsumeRollbackNoticeIfMatches(string platformRoot, string workspacePath)
        {
            var notice = LoadNotice(platformRoot);
            if (notice == null) return false;
            object stored;
            if (!notice.TryGetValue("workspacePath", out stored)) return false;
            var targetPath = Convert.ToString(stored);
            if (!SamePath(targetPath, workspacePath)) return false;
            try { File.Delete(NoticePath(platformRoot)); }
            catch { return false; }
            WriteInstructions(platformRoot, null);
            return true;
        }

        private static void WriteInstructions(string platformRoot, Dictionary<string, object> notice)
        {
            var directory = AgentDirectory(platformRoot);
            Directory.CreateDirectory(directory);
            var builder = new StringBuilder();
            builder.AppendLine("# DevSpace Control Platform managed instructions");
            builder.AppendLine();
            builder.AppendLine("After a successful `show_changes`, write one concise Chinese sentence summarizing that review to a Git note on the reviewRef returned by `show_changes`. Use `exec_command` in the same workspace with:");
            builder.AppendLine("`git notes --ref=devspace-control-platform add -f -m \"<summary>\" <reviewRef>`");
            builder.AppendLine("Summary style: one short sentence, normally 20-60 Chinese characters, in the form `问题/动机；处理结果`. Prefer the user-visible symptom when it explains why the change was needed. State a root cause only when it was actually established; never invent one. Mention the resulting behavior, not file counts or +/- line statistics. Example: `最大化后布局错位；将固定坐标控件改为响应式布局。`");
            builder.AppendLine("Keep it factual and specific; avoid vague phrases such as `优化代码` or `调整逻辑`. This only writes Git metadata; do not modify project files just to store the summary. ControlPlatform maps that reviewRef to its persistent version history and has a local diff summary fallback.");
            builder.AppendLine();
            builder.AppendLine("## Project ownership and local Git");
            builder.AppendLine("Treat a DevSpace workspace and a project/repository as separate concepts. Before editing, determine the canonical project root from the user's task, repository boundaries, and the files that belong together; do not infer ownership only from a parent folder name.");
            builder.AppendLine("If the intended project is already inside Git, use `git rev-parse --show-toplevel` as the canonical repository root and keep all project-scoped work attached to that repository.");
            builder.AppendLine("If the intended project has no Git repository, initialize local Git at the canonical project root before making project changes. Do not initialize a collection folder, workspace parent, or unrelated nested folder just because it is convenient.");
            builder.AppendLine("Inspect `git status`, branch, and HEAD before and after project changes. The Control Platform management UI reads the real local Git history and uses it to identify project ownership.");
            builder.AppendLine("Do not push automatically. Create local commits only when the active authorization policy permits a commit, and commit only files belonging to that project.");

            if (notice != null)
            {
                object workspacePath;
                object version;
                object createdAt;
                object summary;
                object rolledBack;
                notice.TryGetValue("workspacePath", out workspacePath);
                notice.TryGetValue("version", out version);
                notice.TryGetValue("createdAt", out createdAt);
                notice.TryGetValue("summary", out summary);
                notice.TryGetValue("rolledBackReviews", out rolledBack);
                builder.AppendLine();
                builder.AppendLine("## One-time rollback notice");
                builder.AppendLine("This notice applies only when the opened workspace root is exactly:");
                builder.AppendLine(Convert.ToString(workspacePath));
                builder.AppendLine();
                builder.AppendLine("The user has rolled this workspace back " + Convert.ToString(rolledBack) + " review(s) to " + Convert.ToString(version) +
                    " (" + Convert.ToString(createdAt) + "): " + Convert.ToString(summary));
                builder.AppendLine("Treat the current filesystem as authoritative. Do not assume reverted changes still exist; re-read affected files before continuing.");
                builder.AppendLine("If the current workspace root is different, ignore this rollback notice.");
            }

            File.WriteAllText(InstructionsPath(platformRoot), builder.ToString(), new UTF8Encoding(false));
        }

        private static Dictionary<string, object> LoadNotice(string platformRoot)
        {
            var path = NoticePath(platformRoot);
            if (!File.Exists(path)) return null;
            try
            {
                var value = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(
                    File.ReadAllText(path, Encoding.UTF8));
                object schema;
                if (value == null || !value.TryGetValue("schemaVersion", out schema) || Convert.ToInt32(schema) != SchemaVersion)
                    return null;
                return value;
            }
            catch
            {
                return null;
            }
        }

        private static string AgentDirectory(string platformRoot)
        {
            return Path.Combine(Path.GetFullPath(platformRoot), "state", "agent-home");
        }

        private static string InstructionsPath(string platformRoot)
        {
            return Path.Combine(AgentDirectory(platformRoot), "AGENTS.md");
        }

        private static string NoticePath(string platformRoot)
        {
            return Path.Combine(AgentDirectory(platformRoot), "rollback-notice.json");
        }

        private static bool SamePath(string left, string right)
        {
            if (string.IsNullOrWhiteSpace(left) || string.IsNullOrWhiteSpace(right)) return false;
            return string.Equals(
                Path.GetFullPath(left).TrimEnd(Path.DirectorySeparatorChar),
                Path.GetFullPath(right).TrimEnd(Path.DirectorySeparatorChar),
                StringComparison.OrdinalIgnoreCase);
        }
    }
}
