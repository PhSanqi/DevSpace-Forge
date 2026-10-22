using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

namespace DevSpaceControlPlatform
{
    internal static class CloudflareTunnelSecretStore
    {
        public static string TokenPath(string platformRoot)
        {
            return Path.Combine(
                Path.GetFullPath(platformRoot),
                "state",
                "secrets",
                "cloudflare-tunnel-token.txt");
        }

        public static bool HasToken(string platformRoot)
        {
            var path = TokenPath(platformRoot);
            return File.Exists(path) && !string.IsNullOrWhiteSpace(File.ReadAllText(path, Encoding.UTF8));
        }

        public static void SaveToken(string platformRoot, string token)
        {
            var value = (token ?? string.Empty).Trim();
            if (value.Length < 32 || value.IndexOf('\0') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
            {
                throw new InvalidDataException("Cloudflare Tunnel Token 格式无效。");
            }

            var path = TokenPath(platformRoot);
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            // Apply the private ACL at creation so the token is never briefly
            // readable through an inherited directory DACL.
            using (var stream = File.Create(path, 4096, FileOptions.None, PrivateFileSecurity()))
            using (var writer = new StreamWriter(stream, new UTF8Encoding(false)))
            {
                writer.Write(value + Environment.NewLine);
            }
        }

        internal static void RestrictPrivateFile(string path)
        {
            File.SetAccessControl(path, PrivateFileSecurity());
        }

        private static FileSecurity PrivateFileSecurity()
        {
            var currentUser = WindowsIdentity.GetCurrent().User;
            if (currentUser == null) throw new InvalidOperationException("无法识别当前 Windows 用户。");

            var security = new FileSecurity();
            security.SetAccessRuleProtection(true, false);
            security.SetOwner(currentUser);
            security.AddAccessRule(new FileSystemAccessRule(
                currentUser,
                FileSystemRights.FullControl,
                AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                FileSystemRights.FullControl,
                AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
                FileSystemRights.FullControl,
                AccessControlType.Allow));
            return security;
        }
    }
}
