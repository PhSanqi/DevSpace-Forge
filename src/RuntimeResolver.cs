using System;
using System.Collections.Generic;
using System.IO;

namespace DevSpaceControlPlatform
{
    internal static class RuntimeResolver
    {
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
            foreach (var runtimeRoot in RuntimeBaseRoots(platformRoot))
            {
                var pointer = Path.Combine(runtimeRoot, "active-slot.txt");
                if (!File.Exists(pointer))
                {
                    yield return new RuntimeLocation { Root = runtimeRoot, IsSlot = false, SlotName = string.Empty };
                    continue;
                }

                var slotName = File.ReadAllText(pointer).Trim();
                if (string.IsNullOrWhiteSpace(slotName) ||
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
