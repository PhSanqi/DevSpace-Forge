using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace DevSpaceControlPlatform
{
    internal static class RuntimeResolver
    {
        internal static string StateDirectory(string platformRoot)
        {
            var fallback = Path.GetFullPath(Path.Combine(platformRoot, "state", "devspace-state"));
            var config = Path.Combine(platformRoot, "state", "devspace-config", "config.jsonc");
            if (!File.Exists(config)) return fallback;
            var raw = File.ReadAllText(config, Encoding.UTF8);
            // A generated config has a JSON string value; preserve JSONC
            // comments without attempting to reinterpret arbitrary JavaScript.
            var matches = Regex.Matches(raw, @"""stateDir""\s*:\s*(""(?:\\.|[^""\\])*"")");
            if (matches.Count == 0)
            {
                if (raw.Contains("\"stateDir\""))
                    throw new InvalidDataException("Unable to verify the managed Runtime state directory.");
                return fallback;
            }
            if (matches.Count != 1)
                throw new InvalidDataException("Ambiguous managed Runtime state directory.");
            var candidate = new JavaScriptSerializer().Deserialize<string>(matches[0].Groups[1].Value);
            if (string.IsNullOrWhiteSpace(candidate) || !Path.IsPathRooted(candidate))
                throw new InvalidDataException("The managed Runtime state directory must be absolute.");
            return Path.GetFullPath(candidate);
        }

        internal static string SelectionPath(string platformRoot)
        {
            return Path.Combine(StateDirectory(platformRoot), "runtime-selection.json");
        }

        internal static Dictionary<string, object> ReadSelection(string platformRoot)
        {
            var file = SelectionPath(platformRoot);
            if (!File.Exists(file)) return null;
            var selection = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(file, Encoding.UTF8));
            object schema, slot, hash, previous;
            if (selection == null || !selection.TryGetValue("schema_version", out schema) || !(schema is int) || (int)schema != 1 ||
                !selection.TryGetValue("slot", out slot) || !ValidSlot(Convert.ToString(slot)) ||
                !selection.TryGetValue("server_sha256", out hash) || !Regex.IsMatch(Convert.ToString(hash), "^[a-f0-9]{64}$") ||
                !selection.TryGetValue("previous", out previous))
                throw new InvalidDataException("Invalid Runtime JSON selection; legacy mirror was not used.");
            if (previous != null)
            {
                var record = previous as Dictionary<string, object>;
                object priorSlot, priorHash;
                if (record == null || !record.TryGetValue("slot", out priorSlot) || !ValidSlot(Convert.ToString(priorSlot)) ||
                    !record.TryGetValue("server_sha256", out priorHash) || !Regex.IsMatch(Convert.ToString(priorHash), "^[a-f0-9]{64}$"))
                    throw new InvalidDataException("Invalid previous Runtime selection.");
            }
            return selection;
        }

        private static bool ValidSlot(string slot)
        {
            return !string.IsNullOrEmpty(slot) && Regex.IsMatch(slot, "^[A-Za-z0-9][A-Za-z0-9._-]*$");
        }

        private sealed class RuntimeLocation
        {
            public string Root { get; set; }
            public bool IsSlot { get; set; }
            public string SlotName { get; set; }
        }

        public static string ResolveNodePath(string platformRoot)
        {
            var candidates = new List<string>();
            foreach (var location in RuntimeLocations(platformRoot))
            {
                candidates.Add(location.IsSlot
                    ? Path.Combine(location.Root, "node", "node.exe")
                    : Path.Combine(location.Root, "node-v22.22.3-win-x64", "node.exe"));
            }
            if (!File.Exists(SelectionPath(platformRoot)))
                candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"));
            foreach (var candidate in candidates) if (File.Exists(candidate)) return candidate;
            throw new FileNotFoundException("找不到 Node.js runtime。", "node.exe");
        }

        public static string ResolveDevSpacePackageRoot(string platformRoot)
        {
            var candidates = new List<string>();
            foreach (var location in RuntimeLocations(platformRoot))
            {
                candidates.Add(Path.Combine(location.Root, "devspace", "node_modules", "@waishnav", "devspace"));
            }
            foreach (var candidate in candidates)
                if (File.Exists(Path.Combine(candidate, "package.json"))) return candidate;
            throw new DirectoryNotFoundException("找不到独立 DevSpace runtime package。");
        }

        public static string ResolveControlPagePackageRoot(string platformRoot)
        {
            return ResolveDevSpacePackageRoot(platformRoot);
        }

        public static string ResolveCloudflaredPath(string platformRoot)
        {
            var root = Path.GetFullPath(platformRoot);
            var candidates = new[]
            {
                Path.Combine(root, "cloudflared.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "cloudflared", "cloudflared.exe")
            };
            foreach (var candidate in candidates) if (File.Exists(candidate)) return candidate;
            throw new FileNotFoundException("找不到 cloudflared.exe。", candidates[candidates.Length - 1]);
        }

        public static string ResolveSerenaBinDirectory(string platformRoot)
        {
            foreach (var location in RuntimeLocations(platformRoot))
            {
                var candidate = Path.Combine(location.Root, "serena", "bin");
                if (Directory.Exists(candidate)) return candidate;
            }
            if (File.Exists(SelectionPath(platformRoot)))
                return Path.Combine(Path.GetFullPath(platformRoot), "runtime", "slots", ActiveRuntimeSlot(platformRoot), "serena", "bin");
            foreach (var runtimeRoot in RuntimeBaseRoots(platformRoot))
            {
                var candidate = Path.Combine(runtimeRoot, "serena", "bin");
                if (Directory.Exists(candidate)) return candidate;
            }
            return Path.Combine(Path.GetFullPath(platformRoot), "runtime", "serena", "bin");
        }

        public static string ResolveUvDirectory(string platformRoot)
        {
            foreach (var location in RuntimeLocations(platformRoot))
            {
                var candidate = Path.Combine(location.Root, "uv");
                if (Directory.Exists(candidate)) return candidate;
            }
            if (File.Exists(SelectionPath(platformRoot)))
                return Path.Combine(Path.GetFullPath(platformRoot), "runtime", "slots", ActiveRuntimeSlot(platformRoot), "uv");
            foreach (var runtimeRoot in RuntimeBaseRoots(platformRoot))
            {
                var candidate = Path.Combine(runtimeRoot, "uv");
                if (Directory.Exists(candidate)) return candidate;
            }
            return Path.Combine(Path.GetFullPath(platformRoot), "runtime", "uv");
        }

        public static string ActiveRuntimeSlot(string platformRoot)
        {
            foreach (var location in RuntimeLocations(platformRoot))
                if (location.IsSlot) return location.SlotName;
            return string.Empty;
        }

        public static void AddRuntimeToolPaths(
            IDictionary<string, string> environment,
            string platformRoot)
        {
            if (environment == null) throw new ArgumentNullException("environment");

            var entries = new List<string>();
            var serenaBin = ResolveSerenaBinDirectory(platformRoot);
            var uvDir = ResolveUvDirectory(platformRoot);
            if (Directory.Exists(serenaBin)) entries.Add(serenaBin);
            if (Directory.Exists(uvDir)) entries.Add(uvDir);

            string currentPath;
            if (!environment.TryGetValue("PATH", out currentPath) || string.IsNullOrWhiteSpace(currentPath))
                currentPath = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
            if (!string.IsNullOrWhiteSpace(currentPath)) entries.Add(currentPath);

            environment["PATH"] = string.Join(Path.PathSeparator.ToString(), entries.ToArray());
        }

        private static IEnumerable<RuntimeLocation> RuntimeLocations(string platformRoot)
        {
            var selection = ReadSelection(platformRoot);
            if (selection != null)
            {
                var id = Convert.ToString(selection["slot"]);
                var slot = Path.Combine(Path.GetFullPath(platformRoot), "runtime", "slots", id);
                var package = Path.Combine(slot, "devspace", "node_modules", "@waishnav", "devspace");
                var server = Path.Combine(package, "dist", "server.js");
                if (!File.Exists(Path.Combine(slot, "READY")) || !File.Exists(Path.Combine(slot, "node", "node.exe")) ||
                    !File.Exists(Path.Combine(package, "package.json")) || !File.Exists(Path.Combine(package, "dist", "cli.js")) || !File.Exists(server))
                    throw new InvalidDataException("Selected Runtime slot is incomplete; legacy mirror was not used.");
                using (var sha = SHA256.Create())
                using (var stream = File.OpenRead(server))
                    if (BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant() != Convert.ToString(selection["server_sha256"]))
                        throw new InvalidDataException("Selected Runtime hash mismatch; legacy mirror was not used.");
                yield return new RuntimeLocation { Root = slot, IsSlot = true, SlotName = id };
                yield break;
            }
            foreach (var runtimeRoot in RuntimeBaseRoots(platformRoot))
            {
                var pointer = Path.Combine(runtimeRoot, "active-slot.txt");
                if (!File.Exists(pointer))
                {
                    yield return new RuntimeLocation { Root = runtimeRoot, IsSlot = false, SlotName = string.Empty };
                    continue;
                }

                var slotName = File.ReadAllText(pointer).Trim();
                if (!ValidSlot(slotName) ||
                    !string.Equals(slotName, Path.GetFileName(slotName), StringComparison.Ordinal) ||
                    slotName.IndexOfAny(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }) >= 0)
                {
                    throw new InvalidDataException("active-slot.txt 包含无效 Runtime slot 名称。");
                }

                var slotsRoot = Path.GetFullPath(Path.Combine(runtimeRoot, "slots"));
                var slotRoot = Path.GetFullPath(Path.Combine(slotsRoot, slotName));
                if (!slotRoot.StartsWith(slotsRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Runtime slot 超出受管 slots 目录。");
                if (!Directory.Exists(slotRoot) || !File.Exists(Path.Combine(slotRoot, "READY")))
                    throw new DirectoryNotFoundException("Active Runtime slot 尚未准备完成：" + slotName);

                yield return new RuntimeLocation { Root = slotRoot, IsSlot = true, SlotName = slotName };
            }
        }

        private static IEnumerable<string> RuntimeBaseRoots(string platformRoot)
        {
            var root = Path.GetFullPath(platformRoot);
            yield return Path.Combine(root, "runtime");
            var parent = Directory.GetParent(root);
            if (parent != null) yield return Path.Combine(parent.FullName, "runtime");
        }
    }
}
