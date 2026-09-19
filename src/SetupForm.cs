using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace DevSpaceControlPlatform
{
    internal sealed class SetupForm : Form
    {
        private readonly string platformRoot;
        private readonly TextBox rootBox = new TextBox();
        private readonly NumericUpDown portBox = new NumericUpDown();
        private readonly TextBox tunnelNameBox = new TextBox();
        private readonly TextBox hostnameBox = new TextBox();
        private readonly TextBox tokenBox = new TextBox();
        private readonly Label tokenHintLabel = new Label();
        private readonly CheckBox autoStartBox = new CheckBox();
        private readonly Label bundleStatus = new Label();
        private readonly TextBox localOriginBox = new TextBox();
        private readonly TextBox localMcpBox = new TextBox();
        private readonly TextBox publicMcpBox = new TextBox();
        private readonly TextBox ownerBox = new TextBox();
        private readonly Button installButton = new Button();
        private readonly Label statusLabel = new Label();

        public SetupForm()
        {
            platformRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            Text = "DevSpace Control Platform Setup";
            Icon = AppVisuals.CreateApplicationIcon();
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = true;
            ClientSize = new Size(760, 770);
            Font = new Font("Microsoft YaHei UI", 9F);

            var title = new Label
            {
                Text = "DevSpace Control Platform 一键配置",
                Font = new Font(Font.FontFamily, 16F, FontStyle.Bold),
                Location = new Point(24, 20),
                Size = new Size(700, 38)
            };
            Controls.Add(title);

            var intro = new Label
            {
                Text = "这个 Release 已经包含 Node.js、DevSpace Runtime 和 cloudflared。\r\n" +
                       "这里不再下载运行依赖；只需要填写项目目录、端口、Cloudflare hostname 和 Tunnel token。",
                Location = new Point(26, 66),
                Size = new Size(700, 52),
                ForeColor = Color.DimGray
            };
            Controls.Add(intro);

            bundleStatus.SetBounds(26, 120, 700, 30);
            Controls.Add(bundleStatus);

            AddLabel("允许访问的项目目录", 26, 166);
            rootBox.SetBounds(26, 192, 600, 27);
            Controls.Add(rootBox);
            var browse = new Button { Text = "选择…", Location = new Point(638, 190), Size = new Size(92, 30) };
            browse.Click += delegate { BrowseRoot(); };
            Controls.Add(browse);

            AddLabel("本地端口", 26, 238);
            portBox.SetBounds(26, 264, 130, 27);
            portBox.Minimum = 1;
            portBox.Maximum = 65535;
            portBox.Value = 7677;
            portBox.ValueChanged += delegate { RefreshLinks(); };
            Controls.Add(portBox);

            AddLabel("Cloudflare Tunnel 名称（可选，仅记录）", 190, 238);
            tunnelNameBox.SetBounds(190, 264, 440, 27);
            Controls.Add(tunnelNameBox);

            AddLabel("Cloudflare public hostname / 隧道域名", 26, 310);
            hostnameBox.SetBounds(26, 336, 604, 27);
            hostnameBox.TextChanged += delegate { RefreshLinks(); };
            Controls.Add(hostnameBox);
            var hostNote = new Label
            {
                Text = "例如 devspace.example.com。Remote Tunnel 的 Tunnel 名称不参与本机运行；实际需要的是 hostname + token。",
                Location = new Point(26, 366),
                Size = new Size(700, 38),
                ForeColor = Color.DimGray
            };
            Controls.Add(hostNote);

            AddLabel("Cloudflare Remote Tunnel token", 26, 410);
            tokenBox.SetBounds(26, 436, 604, 27);
            tokenBox.UseSystemPasswordChar = true;
            Controls.Add(tokenBox);

            tokenHintLabel.SetBounds(26, 467, 700, 24);
            tokenHintLabel.ForeColor = Color.DimGray;
            Controls.Add(tokenHintLabel);

            autoStartBox.Text = "登录 Windows 后自动启动 DevSpace Control";
            autoStartBox.SetBounds(26, 495, 370, 28);
            autoStartBox.Checked = true;
            Controls.Add(autoStartBox);

            var links = new GroupBox
            {
                Text = "安装后使用的地址",
                Location = new Point(26, 530),
                Size = new Size(704, 188)
            };
            AddReadOnlyRow(links, "Cloudflare 本地 Origin", localOriginBox, 26);
            AddReadOnlyRow(links, "本地 MCP", localMcpBox, 62);
            AddReadOnlyRow(links, "公网 MCP", publicMcpBox, 98);
            AddReadOnlyRow(links, "Owner password", ownerBox, 134);
            Controls.Add(links);

            installButton.Text = "保存配置并启动 Control";
            installButton.SetBounds(26, 724, 220, 38);
            installButton.Click += delegate { Install(); };
            Controls.Add(installButton);

            var copyPublic = new Button { Text = "复制公网 MCP", Location = new Point(260, 724), Size = new Size(130, 38) };
            copyPublic.Click += delegate { CopyIfPresent(publicMcpBox.Text); };
            Controls.Add(copyPublic);

            var copyOwner = new Button { Text = "复制 Owner password", Location = new Point(400, 724), Size = new Size(175, 38) };
            copyOwner.Click += delegate { CopyIfPresent(ownerBox.Text); };
            Controls.Add(copyOwner);

            // Status is shown in the window title after setup because the fixed dialog is kept compact.

            LoadExistingState();
            RefreshLinks();
            ValidateBundleForDisplay();
        }

        private void AddLabel(string text, int x, int y)
        {
            Controls.Add(new Label { Text = text, Location = new Point(x, y), Size = new Size(520, 24) });
        }

        private static void AddReadOnlyRow(Control parent, string label, TextBox box, int y)
        {
            parent.Controls.Add(new Label { Text = label, Location = new Point(14, y + 3), Size = new Size(160, 24) });
            box.SetBounds(175, y, 510, 27);
            box.ReadOnly = true;
            box.BackColor = Color.White;
            parent.Controls.Add(box);
        }

        private void LoadExistingState()
        {
            var settingsPath = Path.Combine(platformRoot, "settings.json");
            try
            {
                var exists = File.Exists(settingsPath);
                var settings = PlatformSettingsStore.Load(settingsPath, platformRoot);
                rootBox.Text = settings.AllowedRoots != null && settings.AllowedRoots.Count > 0
                    ? settings.AllowedRoots[0]
                    : Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
                portBox.Value = Math.Max(portBox.Minimum, Math.Min(portBox.Maximum, settings.LocalPort));
                tunnelNameBox.Text = settings.NamedTunnelIdOrName ?? string.Empty;
                hostnameBox.Text = settings.FixedHostname ?? string.Empty;
                autoStartBox.Checked = exists ? settings.AutoStart : true;
                if (CloudflareTunnelSecretStore.HasToken(platformRoot))
                    tokenHintLabel.Text = "已有受保护 Token；留空会继续使用现有 Token。";
                else
                    tokenHintLabel.Text = "Token 只写入当前用户可访问的本地 secrets 文件。";
            }
            catch
            {
                rootBox.Text = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            }
        }

        private void ValidateBundleForDisplay()
        {
            try
            {
                var version = SetupInstaller.ValidateBundle(platformRoot);
                bundleStatus.Text = "离线 Runtime：READY · DevSpace " + version;
                bundleStatus.ForeColor = Color.DarkGreen;
                installButton.Enabled = true;
            }
            catch (Exception exception)
            {
                if (SetupInstaller.HasOfflinePayload(platformRoot))
                {
                    bundleStatus.Text = "离线 Runtime payload：READY · 点击安装后自动展开（安装过程不联网）";
                    bundleStatus.ForeColor = Color.DarkGreen;
                    installButton.Enabled = true;
                }
                else
                {
                    bundleStatus.Text = "离线包校验失败：" + exception.Message;
                    bundleStatus.ForeColor = Color.DarkRed;
                    installButton.Enabled = false;
                }
            }
        }

        private void BrowseRoot()
        {
            using (var dialog = new FolderBrowserDialog())
            {
                dialog.Description = "选择 ChatGPT / DevSpace 可以访问的项目根目录";
                dialog.SelectedPath = Directory.Exists(rootBox.Text) ? rootBox.Text : string.Empty;
                if (dialog.ShowDialog(this) == DialogResult.OK) rootBox.Text = dialog.SelectedPath;
            }
        }

        private void RefreshLinks()
        {
            var port = Decimal.ToInt32(portBox.Value);
            localOriginBox.Text = SetupInstaller.LocalOrigin(port);
            localMcpBox.Text = SetupInstaller.LocalMcpUrl(port);
            try { publicMcpBox.Text = SetupInstaller.PublicMcpUrl(hostnameBox.Text); }
            catch { publicMcpBox.Text = string.Empty; }
        }

        private void Install()
        {
            installButton.Enabled = false;
            var originalButtonText = installButton.Text;
            installButton.Text = "正在安装离线 Runtime…";
            UseWaitCursor = true;
            Application.DoEvents();
            try
            {
                var result = SetupInstaller.Configure(
                    platformRoot,
                    rootBox.Text,
                    Decimal.ToInt32(portBox.Value),
                    tunnelNameBox.Text,
                    hostnameBox.Text,
                    tokenBox.Text,
                    autoStartBox.Checked);
                localOriginBox.Text = result.LocalOrigin;
                localMcpBox.Text = result.LocalMcpUrl;
                publicMcpBox.Text = result.PublicMcpUrl;
                ownerBox.Text = result.OwnerPassword;

                var app = Path.Combine(platformRoot, "DevSpaceControlPlatform.exe");
                if (!File.Exists(app)) throw new FileNotFoundException("找不到 DevSpaceControlPlatform.exe。", app);
                Process.Start(new ProcessStartInfo { FileName = app, WorkingDirectory = platformRoot, UseShellExecute = true });

                installButton.Text = "正在验证 DevSpace / Cloudflare…";
                Application.DoEvents();
                var connectivity = SetupInstaller.WaitForConnectivity(
                    platformRoot,
                    Decimal.ToInt32(portBox.Value),
                    hostnameBox.Text,
                    60);

                Text = "DevSpace Control Platform Setup - 已完成";
                MessageBox.Show(
                    "配置完成，DevSpace 与 Cloudflare Tunnel 已通过连通性验收。\r\n\r\n" +
                    "本地 MCP：HTTP " + connectivity.LocalStatusCode + "\r\n" +
                    "cloudflared：运行中\r\n" +
                    "公网 MCP：HTTP " + connectivity.PublicStatusCode + "\r\n\r\n" +
                    "Cloudflare Origin：" + result.LocalOrigin + "\r\n" +
                    "本地 MCP：" + result.LocalMcpUrl + "\r\n" +
                    "公网 MCP：" + result.PublicMcpUrl + "\r\n\r\n" +
                    "Owner password 已生成，可在 Setup 或 Control 中复制。",
                    "DevSpace Control Platform",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }
            catch (Exception exception)
            {
                MessageBox.Show(exception.Message, "Setup 失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Text = "DevSpace Control Platform Setup - 配置失败";
            }
            finally
            {
                UseWaitCursor = false;
                installButton.Text = originalButtonText;
                installButton.Enabled = true;
            }
        }

        private static void CopyIfPresent(string value)
        {
            if (!string.IsNullOrWhiteSpace(value)) Clipboard.SetText(value);
        }
    }

}
