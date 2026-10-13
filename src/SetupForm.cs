using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace DevSpaceControlPlatform
{
    internal sealed class SetupForm : Form
    {
        private readonly string bundleRoot;
        private readonly string platformRoot;
        private readonly List<Panel> pages = new List<Panel>();
        private readonly Panel pageHost = new Panel();
        private readonly Panel stepTrack = new Panel();
        private readonly Panel stepFill = new Panel();
        private readonly Label stepLabel = new Label();
        private readonly Label bundleStatus = new Label();
        private readonly Label statusLabel = new Label();
        private readonly Button backButton = new Button();
        private readonly Button nextButton = new Button();
        private readonly Button installButton = new Button();

        private readonly CheckBox domainOwnedBox = new CheckBox();
        private readonly CheckBox cloudflareActiveBox = new CheckBox();
        private readonly CheckBox tunnelCreatedBox = new CheckBox();
        private readonly CheckBox tunnelHealthyBox = new CheckBox();
        private readonly CheckBox publishedRouteBox = new CheckBox();
        private readonly TextBox rootBox = new TextBox();
        private readonly NumericUpDown portBox = new NumericUpDown();
        private readonly TextBox tunnelNameBox = new TextBox();
        private readonly TextBox hostnameBox = new TextBox();
        private readonly TextBox publicEndpointBox = new TextBox();
        private readonly TextBox tokenBox = new TextBox();
        private readonly Label tokenHintLabel = new Label();
        private readonly CheckBox autoStartBox = new CheckBox();
        private readonly TextBox serviceUrlBox = new TextBox();
        private readonly TextBox localOriginBox = new TextBox();
        private readonly TextBox localMcpBox = new TextBox();
        private readonly TextBox publicMcpBox = new TextBox();
        private readonly TextBox ownerBox = new TextBox();
        private readonly TextBox summaryBox = new TextBox();
        private readonly Label tunnelConnectStatus = new Label();
        private readonly Panel advancedPanel = new Panel();
        private readonly Panel resultGroup = new Panel();

        private Process temporaryTunnelProcess;
        private string temporaryTunnelTokenPath = string.Empty;
        private int stepIndex;
        private bool existingConfiguration;
        private bool bundleReady;
        private bool installed;

        public SetupForm()
        {
            bundleRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            platformRoot = SetupInstaller.FindExistingInstallationRoot(bundleRoot);

            Text = "DevSpace-Forge Setup";
            Icon = AppVisuals.CreateApplicationIcon();
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = true;
            ClientSize = new Size(820, 720);
            Font = new Font("Microsoft YaHei UI", 9.5F);
            AppVisuals.ApplyFormTheme(this);

            var title = new Label
            {
                Text = "DevSpace-Forge 安装向导",
                Font = new Font(Font.FontFamily, 17F, FontStyle.Bold),
                Location = new Point(72, 22),
                Size = new Size(700, 38),
                ForeColor = AppVisuals.TextPrimary
            };
            Controls.Add(title);

            var appIcon = new PictureBox
            {
                Image = Icon.ToBitmap(),
                Location = new Point(30, 24),
                Size = new Size(28, 28),
                SizeMode = PictureBoxSizeMode.StretchImage
            };
            Controls.Add(appIcon);

            var intro = new Label
            {
                Text = "不用先理解 Tunnel、Origin 或 Endpoint。按步骤完成 Cloudflare 页面上的操作，Setup 会告诉你下一步要做什么。",
                Location = new Point(30, 66),
                Size = new Size(755, 38),
                ForeColor = AppVisuals.TextSecondary
            };
            Controls.Add(intro);

            bundleStatus.SetBounds(30, 110, 755, 25);
            bundleStatus.ForeColor = AppVisuals.TextSecondary;
            Controls.Add(bundleStatus);

            stepLabel.SetBounds(30, 143, 755, 30);
            stepLabel.Font = new Font(Font.FontFamily, 10F, FontStyle.Bold);
            stepLabel.ForeColor = AppVisuals.TextPrimary;
            Controls.Add(stepLabel);

            stepTrack.SetBounds(30, 172, 755, 5);
            stepTrack.BackColor = Color.FromArgb(226, 226, 230);
            stepFill.SetBounds(0, 0, 0, 4);
            stepFill.BackColor = AppVisuals.Primary;
            stepTrack.Controls.Add(stepFill);
            Controls.Add(stepTrack);

            pageHost.SetBounds(28, 192, 764, 412);
            pageHost.BackColor = AppVisuals.Surface;
            pageHost.BorderStyle = BorderStyle.None;
            AppVisuals.StyleCard(pageHost);
            Controls.Add(pageHost);

            backButton.Text = "上一步";
            backButton.SetBounds(30, 622, 112, 38);
            backButton.Click += delegate { PreviousStep(); };
            Controls.Add(backButton);

            nextButton.Text = "下一步";
            nextButton.SetBounds(672, 622, 112, 38);
            nextButton.Click += delegate { NextStep(); };
            Controls.Add(nextButton);

            installButton.Text = "安装并启动";
            installButton.SetBounds(630, 622, 154, 38);
            installButton.Visible = false;
            installButton.Click += delegate { Install(); };
            Controls.Add(installButton);

            statusLabel.SetBounds(30, 678, 755, 26);
            statusLabel.ForeColor = AppVisuals.TextSecondary;
            Controls.Add(statusLabel);

            portBox.Minimum = 1;
            portBox.Maximum = 65535;
            portBox.Value = 7677;
            portBox.ValueChanged += delegate { RefreshLinks(); };
            hostnameBox.TextChanged += delegate { RefreshLinks(); };
            publicEndpointBox.TextChanged += delegate { RefreshLinks(); };
            tokenBox.TextChanged += delegate { TunnelCommandChanged(); };

            LoadExistingState();
            ValidateBundleForDisplay();
            if (existingConfiguration) BuildExistingUpdatePage();
            else BuildWizardPages();
            AppVisuals.ApplyControlTheme(this);
            AppVisuals.StylePrimaryButton(nextButton);
            AppVisuals.StylePrimaryButton(installButton);
            AppVisuals.StyleSecondaryButton(backButton);
            RefreshLinks();
            ShowStep(0);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            StopTemporaryTunnel();
            base.OnFormClosed(e);
        }

        private void BuildExistingUpdatePage()
        {
            var page = CreatePage();
            AddHeading(page, "检测到现有安装", 18);
            AddParagraph(
                page,
                "Setup 已找到这台电脑现有的 DevSpace-Forge 配置。直接更新会保留项目目录、Cloudflare 凭据、Owner password 和状态数据，只替换产品文件与 Runtime。\r\n\r\n" +
                "安装位置：" + platformRoot,
                58,
                110);

            var settingsGroup = new Panel
            {
                Location = new Point(18, 178),
                Size = new Size(722, 138),
                BackColor = AppVisuals.SurfaceMuted
            };
            AppVisuals.RoundControl(settingsGroup, 12);
            settingsGroup.Controls.Add(new Label
            {
                Text = "当前配置",
                Location = new Point(16, 12),
                Size = new Size(140, 24),
                Font = new Font(Font.FontFamily, 9.5F, FontStyle.Bold),
                ForeColor = AppVisuals.TextPrimary
            });
            AddReadOnlyRow(settingsGroup, "项目目录", rootBox, 45);
            AddReadOnlyRow(settingsGroup, "公网 MCP", publicMcpBox, 82);
            page.Controls.Add(settingsGroup);

            tokenHintLabel.SetBounds(20, 335, 700, 45);
            tokenHintLabel.ForeColor = AppVisuals.TextSecondary;
            page.Controls.Add(tokenHintLabel);

            stepLabel.Text = "现有安装 · 安全更新";
            backButton.Visible = false;
            nextButton.Visible = false;
            installButton.Visible = true;
            installButton.Text = "直接更新现有安装";
            installButton.Enabled = bundleReady;
        }

        private void BuildWizardPages()
        {
            BuildDomainPage();
            BuildTunnelPage();
            BuildConnectorPage();
            BuildPublishedRoutePage();
            BuildProjectPage();
            BuildReviewPage();
        }

        private void BuildDomainPage()
        {
            var page = CreatePage();
            AddHeading(page, "先准备一个你能管理的域名", 18);
            AddParagraph(
                page,
                "不要求购买所谓“免费域名”。你只需要有一个自己能管理 DNS 的域名，并把它加入 Cloudflare。\r\n" +
                "如果 Cloudflare 控制台里这个域名已经显示 Active，这一步就完成了。",
                58,
                74);

            domainOwnedBox.Text = "我已经有一个可以管理的域名";
            domainOwnedBox.SetBounds(22, 145, 650, 28);
            domainOwnedBox.CheckedChanged += delegate { UpdateNavigation(); };
            page.Controls.Add(domainOwnedBox);

            cloudflareActiveBox.Text = "这个域名已经添加到 Cloudflare，并且状态显示 Active";
            cloudflareActiveBox.SetBounds(22, 184, 650, 28);
            cloudflareActiveBox.CheckedChanged += delegate { UpdateNavigation(); };
            page.Controls.Add(cloudflareActiveBox);

            page.Controls.Add(LinkButton("打开 Cloudflare 控制台", 22, 238, "https://dash.cloudflare.com/"));
            page.Controls.Add(LinkButton("查看域名接入说明", 224, 238, "https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/"));

            AddParagraph(
                page,
                "为什么要这样做：后面你会从这个域名里选一个地址，例如 devspace.example.com，Cloudflare 会把它安全地转发到这台电脑。",
                298,
                62);
        }

        private void BuildTunnelPage()
        {
            var page = CreatePage();
            AddHeading(page, "在 Cloudflare 创建一个 Tunnel", 18);
            AddParagraph(
                page,
                "打开 Cloudflare 控制台 → Networking → Tunnels → Create Tunnel。给它起一个容易认的名字即可。\r\n" +
                "创建完成后先不要在终端里执行安装命令，下一步直接把 Cloudflare 给你的整条命令粘贴给 Setup。",
                58,
                76);

            var platform = new Label
            {
                Text = "这台设备：" + CurrentPlatformDescription(),
                Location = new Point(22, 145),
                Size = new Size(680, 28),
                Font = new Font(Font.FontFamily, 9F, FontStyle.Bold),
                ForeColor = IsSupportedWindowsArchitecture() ? Color.DarkGreen : Color.DarkRed
            };
            page.Controls.Add(platform);

            AddFieldLabel(page, "Tunnel 名称或 ID（可选，方便以后识别）", 22, 184);
            tunnelNameBox.SetBounds(22, 210, 650, 27);
            page.Controls.Add(tunnelNameBox);

            tunnelCreatedBox.Text = "我已经在 Cloudflare 创建好了这个 Tunnel";
            tunnelCreatedBox.SetBounds(22, 257, 650, 28);
            tunnelCreatedBox.CheckedChanged += delegate { UpdateNavigation(); };
            page.Controls.Add(tunnelCreatedBox);

            page.Controls.Add(LinkButton("打开 Cloudflare Tunnels", 22, 310, "https://one.dash.cloudflare.com/"));
        }

        private void BuildConnectorPage()
        {
            var page = CreatePage();
            AddHeading(page, "把这台电脑连接到刚才的 Tunnel", 18);
            AddParagraph(
                page,
                "Cloudflare 的 Setup Environment 会让你选择操作系统和架构。当前设备是 " + CurrentPlatformDescription() + "。\r\n" +
                "选择对应项后，复制 Cloudflare 显示的完整 “Install and Run” 命令，直接粘贴到下面。不要自己截取 Token，也不要先去终端执行。",
                58,
                78);

            AddFieldLabel(page, "Cloudflare 完整安装命令", 22, 150);
            tokenBox.SetBounds(22, 176, 680, 28);
            tokenBox.UseSystemPasswordChar = true;
            page.Controls.Add(tokenBox);

            var connect = new Button
            {
                Text = "连接这台电脑",
                Location = new Point(22, 222),
                Size = new Size(150, 34)
            };
            connect.Click += delegate { ConnectTemporaryTunnel(); };
            page.Controls.Add(connect);

            tunnelConnectStatus.SetBounds(188, 226, 510, 44);
            tunnelConnectStatus.ForeColor = Color.DimGray;
            tunnelConnectStatus.Text = "Setup 会读取命令中的凭据并启动随安装包附带的 cloudflared。";
            page.Controls.Add(tunnelConnectStatus);

            tunnelHealthyBox.Text = "Cloudflare 页面里这个 Tunnel 已经显示 Healthy / Connected";
            tunnelHealthyBox.SetBounds(22, 282, 670, 28);
            tunnelHealthyBox.CheckedChanged += delegate { UpdateNavigation(); };
            page.Controls.Add(tunnelHealthyBox);

            AddParagraph(
                page,
                "Setup 不会再安装第二套 Windows cloudflared 服务。这里先临时保持连接，让你完成 Cloudflare 配置；最终安装后由 DevSpace Control 自己负责启动和守护这条连接。",
                327,
                62);
        }

        private void BuildPublishedRoutePage()
        {
            var page = CreatePage();
            AddHeading(page, "给 DevSpace 发布一个访问地址", 18);
            AddParagraph(
                page,
                "回到刚才的 Tunnel → Routes → Add route → Published application。\r\n" +
                "先选一个子域名和你的域名，然后把 Service URL 填成 Setup 下面给出的地址。这里不需要理解 Origin 或 Endpoint。",
                58,
                72);

            AddFieldLabel(page, "DevSpace 本地端口", 22, 140);
            portBox.SetBounds(22, 166, 125, 27);
            page.Controls.Add(portBox);

            AddFieldLabel(page, "Cloudflare 的 Service URL（原样复制）", 178, 140);
            serviceUrlBox.SetBounds(178, 166, 400, 27);
            serviceUrlBox.ReadOnly = true;
            serviceUrlBox.BackColor = Color.White;
            page.Controls.Add(serviceUrlBox);
            var copyService = new Button { Text = "复制", Location = new Point(590, 164), Size = new Size(88, 30) };
            copyService.Click += delegate { CopyIfPresent(serviceUrlBox.Text); };
            page.Controls.Add(copyService);

            AddFieldLabel(page, "你刚才发布的访问域名", 22, 214);
            hostnameBox.SetBounds(22, 240, 656, 27);
            page.Controls.Add(hostnameBox);
            var example = new Label
            {
                Text = "例如 devspace.example.com（填写你自己的域名，不要加 /mcp）",
                Location = new Point(22, 271),
                Size = new Size(650, 24),
                ForeColor = Color.DimGray
            };
            page.Controls.Add(example);

            publishedRouteBox.Text = "我已经保存 Published application，并且页面没有报错";
            publishedRouteBox.SetBounds(22, 306, 660, 28);
            publishedRouteBox.CheckedChanged += delegate { UpdateNavigation(); };
            page.Controls.Add(publishedRouteBox);

            AddParagraph(
                page,
                "此时 DevSpace 本地服务还没正式启动，所以保存后立即访问域名可能暂时打不开，这是正常的。Cloudflare Access 登录保护也是可选的，可以在安装完成后再加。",
                350,
                42);
        }

        private void BuildProjectPage()
        {
            var page = CreatePage();
            AddHeading(page, "选择 AI 可以访问哪些项目", 18);
            AddParagraph(
                page,
                "选择一个项目根目录。DevSpace 的文件工具只允许在这个范围内打开 workspace。建议选专门的代码目录，不要直接授权整个系统盘。",
                58,
                58);

            AddFieldLabel(page, "项目根目录", 22, 130);
            rootBox.SetBounds(22, 156, 560, 27);
            page.Controls.Add(rootBox);
            var browse = new Button { Text = "选择…", Location = new Point(594, 154), Size = new Size(90, 30) };
            browse.Click += delegate { BrowseRoot(); };
            page.Controls.Add(browse);

            autoStartBox.Text = "登录 Windows 后自动启动 DevSpace Control";
            autoStartBox.SetBounds(22, 204, 420, 28);
            autoStartBox.Checked = true;
            page.Controls.Add(autoStartBox);

            var advanced = new Button
            {
                Text = "高级：多机器统一地址",
                Location = new Point(22, 254),
                Size = new Size(190, 32)
            };
            advanced.Click += delegate
            {
                advancedPanel.Visible = !advancedPanel.Visible;
                advanced.Text = advancedPanel.Visible ? "收起高级设置" : "高级：多机器统一地址";
            };
            page.Controls.Add(advanced);

            advancedPanel.SetBounds(22, 296, 662, 86);
            advancedPanel.Visible = false;
            advancedPanel.BorderStyle = BorderStyle.None;
            advancedPanel.BackColor = AppVisuals.SurfaceMuted;
            AppVisuals.RoundControl(advancedPanel, 12);
            advancedPanel.Controls.Add(new Label
            {
                Text = "只有自己搭了多机器网关时才需要。普通安装请留空。",
                Location = new Point(10, 8),
                Size = new Size(630, 22),
                ForeColor = AppVisuals.TextSecondary
            });
            advancedPanel.Controls.Add(new Label
            {
                Text = "统一公网地址",
                Location = new Point(10, 38),
                Size = new Size(125, 24)
            });
            publicEndpointBox.SetBounds(140, 35, 495, 27);
            advancedPanel.Controls.Add(publicEndpointBox);
            page.Controls.Add(advancedPanel);
        }

        private void BuildReviewPage()
        {
            var page = CreatePage();
            AddHeading(page, "确认后开始安装", 18);
            AddParagraph(page, "Setup 会保存配置、把 Tunnel 凭据写入当前用户的受保护文件，然后启动 DevSpace Control。", 55, 45);

            summaryBox.SetBounds(20, 108, 682, 118);
            summaryBox.Multiline = true;
            summaryBox.ReadOnly = true;
            summaryBox.BackColor = AppVisuals.SurfaceMuted;
            summaryBox.ScrollBars = ScrollBars.Vertical;
            page.Controls.Add(summaryBox);

            resultGroup.SetBounds(20, 220, 682, 174);
            resultGroup.BackColor = AppVisuals.SurfaceMuted;
            AppVisuals.RoundControl(resultGroup, 12);
            resultGroup.Visible = false;
            resultGroup.Controls.Add(new Label
            {
                Text = "安装完成后使用这些地址",
                Location = new Point(14, 10),
                Size = new Size(300, 24),
                Font = new Font(Font.FontFamily, 9.5F, FontStyle.Bold),
                ForeColor = AppVisuals.TextPrimary
            });
            AddReadOnlyRow(resultGroup, "本地 MCP", localMcpBox, 38);
            AddReadOnlyRow(resultGroup, "公网 MCP", publicMcpBox, 72);
            AddReadOnlyRow(resultGroup, "Owner password", ownerBox, 106);
            var copyPublic = new Button { Text = "复制公网 MCP", Location = new Point(420, 140), Size = new Size(112, 27) };
            copyPublic.Click += delegate { CopyIfPresent(publicMcpBox.Text); };
            resultGroup.Controls.Add(copyPublic);
            var copyOwner = new Button { Text = "复制密码", Location = new Point(540, 140), Size = new Size(96, 27) };
            copyOwner.Click += delegate { CopyIfPresent(ownerBox.Text); };
            resultGroup.Controls.Add(copyOwner);
            page.Controls.Add(resultGroup);
        }

        private Panel CreatePage()
        {
            var page = new Panel
            {
                Dock = DockStyle.Fill,
                Visible = false,
                BackColor = AppVisuals.Surface,
                Padding = new Padding(8)
            };
            pages.Add(page);
            pageHost.Controls.Add(page);
            return page;
        }

        private void ShowStep(int value)
        {
            if (pages.Count == 0) return;
            stepIndex = Math.Max(0, Math.Min(value, pages.Count - 1));
            for (var i = 0; i < pages.Count; i++) pages[i].Visible = i == stepIndex;

            if (!existingConfiguration)
            {
                var names = new[] { "准备域名", "创建 Tunnel", "连接设备", "发布访问地址", "授权项目", "确认安装" };
                stepLabel.Text = "第 " + (stepIndex + 1) + " / " + pages.Count + " 步 · " + names[stepIndex];
                stepFill.Width = Math.Max(20, stepTrack.ClientSize.Width * (stepIndex + 1) / pages.Count);
                if (stepIndex == pages.Count - 1) UpdateSummary();
            }
            else
            {
                stepFill.Width = stepTrack.ClientSize.Width;
            }
            UpdateNavigation();
        }

        private void PreviousStep()
        {
            if (stepIndex > 0) ShowStep(stepIndex - 1);
        }

        private void NextStep()
        {
            try
            {
                ValidateCurrentStep();
                ShowStep(stepIndex + 1);
            }
            catch (Exception exception)
            {
                MessageBox.Show(exception.Message, "还差一步", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }

        private void ValidateCurrentStep()
        {
            if (existingConfiguration) return;
            switch (stepIndex)
            {
                case 0:
                    if (!domainOwnedBox.Checked || !cloudflareActiveBox.Checked)
                        throw new InvalidOperationException("请先确认域名已经由你管理，并且已经在 Cloudflare 显示 Active。");
                    break;
                case 1:
                    if (!IsSupportedWindowsArchitecture())
                        throw new NotSupportedException("当前 Windows 安装包只支持 x64，检测到 " + CurrentArchitecture() + "。请使用匹配的发行包。");
                    if (!tunnelCreatedBox.Checked)
                        throw new InvalidOperationException("请先在 Cloudflare 创建 Tunnel，然后勾选确认。");
                    break;
                case 2:
                    if (!TemporaryTunnelIsAlive())
                        throw new InvalidOperationException("请先粘贴 Cloudflare 的完整安装命令，然后点击“连接这台电脑”。");
                    if (!tunnelHealthyBox.Checked)
                        throw new InvalidOperationException("请等 Cloudflare 页面显示 Tunnel 已连接，再勾选确认。");
                    break;
                case 3:
                    if (!publishedRouteBox.Checked)
                        throw new InvalidOperationException("请先在 Tunnel 的 Routes 中保存 Published application。");
                    if (string.IsNullOrWhiteSpace(hostnameBox.Text))
                        throw new InvalidDataException("请填写刚才发布的访问域名。");
                    SetupInstaller.NormalizeOriginHostname(hostnameBox.Text);
                    break;
                case 4:
                    if (string.IsNullOrWhiteSpace(rootBox.Text) || !Directory.Exists(rootBox.Text))
                        throw new DirectoryNotFoundException("请选择一个真实存在的项目根目录。");
                    if (!string.IsNullOrWhiteSpace(publicEndpointBox.Text))
                        SetupInstaller.ResolvePublicEndpoint(hostnameBox.Text, publicEndpointBox.Text);
                    break;
            }
        }

        private void UpdateNavigation()
        {
            if (existingConfiguration)
            {
                installButton.Enabled = bundleReady && !installed;
                return;
            }
            if (pages.Count == 0) return;
            backButton.Visible = stepIndex > 0 && !installed;
            nextButton.Visible = stepIndex < pages.Count - 1 && !installed;
            installButton.Visible = stepIndex == pages.Count - 1;
            installButton.Enabled = bundleReady && !installed;
        }

        private void LoadExistingState()
        {
            var settingsPath = Path.Combine(platformRoot, "settings.json");
            try
            {
                var exists = File.Exists(settingsPath);
                var settings = PlatformSettingsStore.Load(settingsPath, platformRoot);
                existingConfiguration = exists;
                rootBox.Text = settings.AllowedRoots != null && settings.AllowedRoots.Count > 0
                    ? settings.AllowedRoots[0]
                    : Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
                portBox.Value = Math.Max(portBox.Minimum, Math.Min(portBox.Maximum, settings.LocalPort));
                tunnelNameBox.Text = settings.NamedTunnelIdOrName ?? string.Empty;
                var origin = settings.AllowedHosts != null && settings.AllowedHosts.Count > 0
                    ? settings.AllowedHosts[0]
                    : (settings.FixedHostname ?? string.Empty);
                hostnameBox.Text = origin;
                publicEndpointBox.Text = string.Equals(origin, settings.FixedHostname ?? string.Empty, StringComparison.OrdinalIgnoreCase)
                    ? string.Empty
                    : (settings.FixedHostname ?? string.Empty);
                autoStartBox.Checked = exists ? settings.AutoStart : true;
                tokenHintLabel.Text = existingConfiguration
                    ? "已有配置将原样保留；Runtime 和产品文件更新完成后会重新启动。"
                    : "Cloudflare 凭据只保存在当前用户可访问的本机 secrets 文件中。";
            }
            catch
            {
                existingConfiguration = false;
                rootBox.Text = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
                autoStartBox.Checked = true;
            }
        }

        private void ValidateBundleForDisplay()
        {
            try
            {
                var version = SetupInstaller.ValidateBundle(bundleRoot);
                bundleStatus.Text = "离线 Runtime：READY · DevSpace " + version;
                bundleStatus.ForeColor = Color.DarkGreen;
                bundleReady = true;
            }
            catch (Exception exception)
            {
                if (SetupInstaller.HasOfflinePayload(bundleRoot))
                {
                    bundleStatus.Text = "离线 Runtime payload：READY · 安装时自动展开，不下载运行依赖";
                    bundleStatus.ForeColor = Color.DarkGreen;
                    bundleReady = true;
                }
                else
                {
                    bundleStatus.Text = "离线包校验失败：" + exception.Message;
                    bundleStatus.ForeColor = Color.DarkRed;
                    bundleReady = false;
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
            serviceUrlBox.Text = SetupInstaller.LocalOrigin(port);
            localOriginBox.Text = serviceUrlBox.Text;
            var endpoint = string.IsNullOrWhiteSpace(publicEndpointBox.Text) ? hostnameBox.Text : publicEndpointBox.Text;
            try
            {
                if (!string.IsNullOrWhiteSpace(hostnameBox.Text))
                {
                    var resolved = SetupInstaller.ResolvePublicEndpoint(hostnameBox.Text, publicEndpointBox.Text);
                    localMcpBox.Text = SetupInstaller.LocalMcpUrl(port, resolved);
                    publicMcpBox.Text = SetupInstaller.PublicMcpUrl(endpoint);
                }
                else
                {
                    localMcpBox.Text = SetupInstaller.LocalMcpUrl(port);
                    publicMcpBox.Text = string.Empty;
                }
            }
            catch
            {
                localMcpBox.Text = SetupInstaller.LocalMcpUrl(port);
                publicMcpBox.Text = string.Empty;
            }
            if (!existingConfiguration && pages.Count > 0 && stepIndex == pages.Count - 1) UpdateSummary();
        }

        private void ConnectTemporaryTunnel()
        {
            StopTemporaryTunnel();
            if (string.IsNullOrWhiteSpace(tokenBox.Text))
            {
                MessageBox.Show("请先粘贴 Cloudflare 给出的完整 Install and Run 命令。", "需要安装命令", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            UseWaitCursor = true;
            tunnelConnectStatus.Text = "正在读取命令并连接 Cloudflare…";
            tunnelConnectStatus.ForeColor = Color.DimGray;
            Application.DoEvents();
            try
            {
                temporaryTunnelProcess = SetupInstaller.StartTemporaryRemoteTunnel(
                    bundleRoot,
                    tokenBox.Text,
                    out temporaryTunnelTokenPath);
                tunnelConnectStatus.Text = "连接进程已启动。回 Cloudflare 等待 Tunnel 显示 Healthy / Connected。";
                tunnelConnectStatus.ForeColor = Color.DarkGreen;
            }
            catch (Exception exception)
            {
                tunnelConnectStatus.Text = "连接失败：" + exception.Message;
                tunnelConnectStatus.ForeColor = Color.DarkRed;
            }
            finally
            {
                UseWaitCursor = false;
                UpdateNavigation();
            }
        }

        private void TunnelCommandChanged()
        {
            if (temporaryTunnelProcess == null) return;
            StopTemporaryTunnel();
            tunnelHealthyBox.Checked = false;
            tunnelConnectStatus.Text = "安装命令已修改，请重新点击“连接这台电脑”。";
            tunnelConnectStatus.ForeColor = Color.DimGray;
            UpdateNavigation();
        }

        private bool TemporaryTunnelIsAlive()
        {
            if (temporaryTunnelProcess == null) return false;
            try { return !temporaryTunnelProcess.HasExited; }
            catch { return false; }
        }

        private void StopTemporaryTunnel()
        {
            var process = temporaryTunnelProcess;
            temporaryTunnelProcess = null;
            var tokenPath = temporaryTunnelTokenPath;
            temporaryTunnelTokenPath = string.Empty;
            SetupInstaller.StopTemporaryRemoteTunnel(process, tokenPath);
        }

        private void UpdateSummary()
        {
            if (existingConfiguration) return;
            var root = string.IsNullOrWhiteSpace(rootBox.Text) ? "（尚未选择）" : rootBox.Text;
            var host = string.IsNullOrWhiteSpace(hostnameBox.Text) ? "（尚未填写）" : hostnameBox.Text.Trim();
            var publicUrl = string.IsNullOrWhiteSpace(publicMcpBox.Text) ? "（配置完成后生成）" : publicMcpBox.Text;
            summaryBox.Text =
                "项目目录：" + root + Environment.NewLine +
                "本地服务：" + SetupInstaller.LocalOrigin(Decimal.ToInt32(portBox.Value)) + Environment.NewLine +
                "Cloudflare 访问域名：" + host + Environment.NewLine +
                "最终公网 MCP：" + publicUrl + Environment.NewLine +
                "Windows 自动启动：" + (autoStartBox.Checked ? "开启" : "关闭");
        }

        private void Install()
        {
            if (installed) return;
            installButton.Enabled = false;
            var originalButtonText = installButton.Text;
            installButton.Text = existingConfiguration ? "正在更新…" : "正在安装…";
            statusLabel.Text = existingConfiguration
                ? "正在执行安全更新检查并准备替换 Runtime…"
                : "正在保存配置并准备离线 Runtime…";
            statusLabel.ForeColor = AppVisuals.TextSecondary;
            UseWaitCursor = true;
            Application.DoEvents();
            try
            {
                if (!existingConfiguration)
                {
                    ValidateCurrentStep();
                    StopTemporaryTunnel();
                }
                var result = existingConfiguration
                    ? SetupInstaller.UpdateExisting(bundleRoot, platformRoot)
                    : SetupInstaller.Configure(
                        platformRoot,
                        rootBox.Text,
                        Decimal.ToInt32(portBox.Value),
                        tunnelNameBox.Text,
                        hostnameBox.Text,
                        publicEndpointBox.Text,
                        tokenBox.Text,
                        autoStartBox.Checked);

                localOriginBox.Text = result.LocalOrigin;
                localMcpBox.Text = result.LocalMcpUrl;
                publicMcpBox.Text = result.PublicMcpUrl;
                ownerBox.Text = result.OwnerPassword;
                if (!existingConfiguration) tokenBox.Clear();

                statusLabel.Text = "配置已准备完成，正在启动 DevSpace-Forge Desktop…";
                Application.DoEvents();
                SetupInstaller.StartWindowsDesktop(platformRoot);

                installed = true;
                Text = "DevSpace-Forge Setup - 已完成";
                if (!existingConfiguration)
                {
                    resultGroup.Visible = true;
                    UpdateSummary();
                }

                var connectivityWarning = string.Empty;
                statusLabel.Text = "已安装并启动，正在验证本地服务、Tunnel 和公网地址…";
                statusLabel.ForeColor = AppVisuals.TextSecondary;
                Application.DoEvents();
                try
                {
                    var endpoint = string.IsNullOrWhiteSpace(publicEndpointBox.Text)
                        ? hostnameBox.Text
                        : publicEndpointBox.Text;
                    SetupInstaller.WaitForConnectivity(
                        platformRoot,
                        Decimal.ToInt32(portBox.Value),
                        endpoint,
                        12);
                    statusLabel.Text = existingConfiguration
                        ? "更新完成，现有配置已保留；本地与公网连接验证通过。"
                        : "安装完成；本地与公网连接验证通过。";
                    statusLabel.ForeColor = AppVisuals.Success;
                }
                catch (Exception connectivityException)
                {
                    connectivityWarning = connectivityException.Message;
                    statusLabel.Text = "安装已经完成，但连接还需要检查。可以在 Control 的“概览 / 连接”页继续处理。";
                    statusLabel.ForeColor = AppVisuals.Warning;
                }

                MessageBox.Show(
                    (existingConfiguration ? "现有安装已更新完成。" : "DevSpace-Forge 已安装并启动。") + "\r\n\r\n" +
                    "公网 MCP：" + result.PublicMcpUrl + "\r\n\r\n" +
                    "Owner password 已生成，请只在自己的设备上保存和使用。" +
                    (string.IsNullOrWhiteSpace(connectivityWarning)
                        ? "\r\n\r\n本地服务、Tunnel 和公网地址已验证通过。"
                        : "\r\n\r\n连接验收暂未通过：\r\n" + connectivityWarning),
                    "DevSpace-Forge",
                    MessageBoxButtons.OK,
                    string.IsNullOrWhiteSpace(connectivityWarning) ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
            }
            catch (Exception exception)
            {
                statusLabel.Text = "安装没有完成：" + exception.Message;
                statusLabel.ForeColor = AppVisuals.Danger;
                MessageBox.Show(exception.Message, "Setup 失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                UseWaitCursor = false;
                if (!installed)
                {
                    installButton.Text = originalButtonText;
                    installButton.Enabled = bundleReady;
                }
                else
                {
                    installButton.Text = "已完成";
                    installButton.Enabled = false;
                }
                UpdateNavigation();
            }
        }

        private static string CurrentPlatformDescription()
        {
            return "Windows " + CurrentArchitecture() + "（已自动检测）";
        }

        private static bool IsSupportedWindowsArchitecture()
        {
            return string.Equals(CurrentArchitecture(), "x64", StringComparison.OrdinalIgnoreCase);
        }

        private static string CurrentArchitecture()
        {
            var architecture = Environment.GetEnvironmentVariable("PROCESSOR_ARCHITEW6432");
            if (string.IsNullOrWhiteSpace(architecture))
                architecture = Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE");
            var normalized = (architecture ?? string.Empty).Trim().ToUpperInvariant();
            if (normalized == "AMD64" || normalized == "IA64") return "x64";
            if (normalized == "X86") return "x86";
            if (normalized == "ARM64") return "ARM64";
            return normalized.Length == 0 ? (Environment.Is64BitOperatingSystem ? "64-bit" : "32-bit") : normalized;
        }

        private static Button LinkButton(string text, int x, int y, string url)
        {
            var button = new Button { Text = text, Location = new Point(x, y), Size = new Size(190, 34) };
            button.Click += delegate { OpenLink(url); };
            return button;
        }

        private static void OpenLink(string url)
        {
            try
            {
                Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
            }
            catch (Exception exception)
            {
                MessageBox.Show("无法打开浏览器：" + exception.Message, "打开链接失败", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private static void AddHeading(Control parent, string text, int y)
        {
            parent.Controls.Add(new Label
            {
                Text = text,
                Location = new Point(20, y),
                Size = new Size(680, 30),
                Font = new Font(parent.Font.FontFamily, 13F, FontStyle.Bold),
                ForeColor = AppVisuals.TextPrimary
            });
        }

        private static void AddParagraph(Control parent, string text, int y, int height)
        {
            parent.Controls.Add(new Label
            {
                Text = text,
                Location = new Point(22, y),
                Size = new Size(680, height),
                ForeColor = AppVisuals.TextSecondary
            });
        }

        private static void AddFieldLabel(Control parent, string text, int x, int y)
        {
            parent.Controls.Add(new Label
            {
                Text = text,
                Location = new Point(x, y),
                Size = new Size(500, 24),
                ForeColor = AppVisuals.TextSecondary
            });
        }

        private static void AddReadOnlyRow(Control parent, string label, TextBox box, int y)
        {
            parent.Controls.Add(new Label
            {
                Text = label,
                Location = new Point(14, y + 3),
                Size = new Size(135, 24),
                ForeColor = AppVisuals.TextSecondary
            });
            box.SetBounds(150, y, 505, 27);
            box.ReadOnly = true;
            box.BackColor = AppVisuals.Surface;
            parent.Controls.Add(box);
        }

        private static void CopyIfPresent(string value)
        {
            if (!string.IsNullOrWhiteSpace(value)) Clipboard.SetText(value);
        }
    }
}
