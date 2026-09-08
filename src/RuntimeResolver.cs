using System;
using System.Collections.Generic;
using System.IO;

namespace DevSpaceControlPlatform
{
    internal static class RuntimeResolver
    {
        public static string ResolveNodePath(string platformRoot)
        {
            var root = Path.GetFullPath(platformRoot);
            var candidates = new List<string>
            {
                Path.Combine(root, "runtime", "node-v22.22.3-win-x64", "node.exe")
            };
            var parent = Directory.GetParent(root);
            if (parent != null)
                candidates.Add(Path.Combine(parent.FullName, "runtime", "node-v22.22.3-win-x64", "node.exe"));
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"));
            foreach (var candidate in candidates) if (File.Exists(candidate)) return candidate;
            throw new FileNotFoundException("找不到 Node.js runtime。", "node.exe");
        }

        public static string ResolveDevSpacePackageRoot(string platformRoot)
        {
            var root = Path.GetFullPath(platformRoot);
            var candidates = new List<string>
            {
                Path.Combine(root, "runtime", "devspace", "node_modules", "@waishnav", "devspace")
            };
            var parent = Directory.GetParent(root);
            if (parent != null)
                candidates.Add(Path.Combine(parent.FullName, "runtime", "devspace", "node_modules", "@waishnav", "devspace"));
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
    }
}
