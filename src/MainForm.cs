using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Windows.Forms;

namespace DevSpaceControlPlatform
{
    internal sealed class StableDataGridView : DataGridView
    {
        public StableDataGridView()
        {
            DoubleBuffered = true;
            ResizeRedraw = false;
        }
    }

    internal sealed class ReviewWorkspaceChoice
    {
        public string Path { get; set; }
        public string DisplayName { get; set; }

        public override string ToString()
        {
            return DisplayName ?? string.Empty;
        }
    }

    internal sealed class MainForm : Form
    {
        private readonly ServiceSupervisor supervisor;
        private readonly string platformRoot;
        private readonly string settingsPath;
        private readonly string configDirectory;
        private readonly string historyDirectory;
        private readonly ConfigurationHistory history;

        private PlatformSettings settings;
        private DevSpaceVersion detectedVersion;
        private string detectedPackageRoot;

        private readonly TabControl tabs = new TabControl();
        private readonly ListBox rootsList = new ListBox();
        private readonly NumericUpDown portBox = new NumericUpDown();
        private readonly ComboBox tunnelModeBox = new ComboBox();
        private readonly TextBox hostnameBox = new TextBox();
        private readonly TextBox tunnelIdBox = new TextBox();
        private readonly TextBox credentialsBox = new TextBox();
        private readonly TextBox cloudflaredConfigBox = new TextBox();
        private readonly TextBox cloudflareTokenBox = new TextBox();
        private readonly Label cloudflareTokenStatusLabel = new Label();
        private readonly CheckBox autoStartBox = new CheckBox();

        private readonly TextBox packageRootBox = new TextBox();
        private readonly Label versionLabel = new Label();
        private readonly ComboBox toolModeBox = new ComboBox();
        private readonly CheckBox reviewUiBox = new CheckBox();
        private readonly CheckBox skillsBox = new CheckBox();
        private readonly TextBox skillPathsBox = new TextBox();
        private readonly Label subagentLabel = new Label();
        private readonly Label managedConfigLabel = new Label();

        private readonly ComboBox logLevelBox = new ComboBox();
        private readonly ComboBox logFormatBox = new ComboBox();
        private readonly CheckBox logRequestsBox = new CheckBox();
        private readonly CheckBox logToolCallsBox = new CheckBox();
        private readonly CheckBox logShellCommandsBox = new CheckBox();
        private readonly TextBox diagnosticsBox = new TextBox();
        private readonly TextBox liveLogBox = new TextBox();
        private readonly TextBox conversationLogBox = new TextBox();
        private readonly ComboBox conversationLogSelector = new ComboBox();
        private readonly Label latestToolCallLabel = new Label();
        private readonly DataGridView reviewHistoryGrid = new StableDataGridView();
        private readonly DataGridView gitHistoryGrid = new StableDataGridView();
        private readonly ComboBox reviewWorkspaceBox = new ComboBox();
        private readonly Label reviewWorkspaceLabel = new Label();
        private readonly Label gitRepositoryStatusLabel = new Label();
        private readonly Label reviewHistoryStatusLabel = new Label();
        private readonly Button rollbackSelectedReviewButton = new Button();
        private readonly List<DevSpaceReviewVersion> reviewVersions = new List<DevSpaceReviewVersion>();

        private readonly ListBox historyList = new ListBox();
        private readonly TextBox historyPreviewBox = new TextBox();

        private readonly Label statusLabel = new Label();
        private readonly Button saveButton = new Button();
        private readonly Label devSpaceServiceLabel = new Label();
        private readonly Label cloudflareServiceLabel = new Label();
        private readonly TextBox managedMcpUrlBox = new TextBox();
        private DateTime lastReviewHistoryRefreshUtc = DateTime.MinValue;
        private bool updatingReviewWorkspaceBox;
        private bool updatingConversationLogSelector;
        private bool allowApplicationClose;

        public MainForm(ServiceSupervisor supervisor)
        {
            if (supervisor == null) throw new ArgumentNullException("supervisor");
            this.supervisor = supervisor;
            platformRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            settingsPath = Path.Combine(platformRoot, "settings.json");
            configDirectory = Path.Combine(platformRoot, "state", "devspace-config");
            historyDirectory = Path.Combine(platformRoot, "state", "config-history");
            history = new ConfigurationHistory(historyDirectory, 20);

            Text = "DevSpace Control Platform";
            Icon = AppVisuals.CreateApplicationIcon();
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(1000, 760);
            ClientSize = new Size(1000, 760);
            Font = new Font("Microsoft YaHei UI", 9F);

            BuildLayout();
            LoadState();
            tabs.SelectedIndexChanged += delegate
            {
                if (tabs.SelectedTab != null && string.Equals(tabs.SelectedTab.Text, "项目 / Git", StringComparison.Ordinal))
                    RefreshReviewHistory();
            };
        }

        private void BuildLayout()
        {
            var shell = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 2,
                Margin = new Padding(0),
                Padding = new Padding(0)
            };
            shell.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            shell.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            shell.RowStyles.Add(new RowStyle(SizeType.Absolute, 54F));

            tabs.Dock = DockStyle.Fill;
            tabs.TabPages.Add(BuildServicesTab());
            tabs.TabPages.Add(BuildConnectionTab());
            tabs.TabPages.Add(BuildDevSpaceTab());
            tabs.TabPages.Add(BuildDiagnosticsTab());
            tabs.TabPages.Add(BuildReviewHistoryTab());
            tabs.TabPages.Add(BuildHistoryTab());

            var bottom = new Panel { Dock = DockStyle.Fill, Margin = new Padding(0), Padding = new Padding(12, 8, 12, 8) };
            statusLabel.AutoEllipsis = true;
            statusLabel.Location = new Point(12, 15);
            statusLabel.Size = new Size(720, 26);
            statusLabel.ForeColor = Color.DimGray;
            bottom.Controls.Add(statusLabel);

            saveButton.Text = "保存配置";
            saveButton.Size = new Size(110, 32);
            saveButton.Location = new Point(858, 8);
            saveButton.Click += delegate { SaveCurrentSettings(); };
            bottom.Controls.Add(saveButton);

            shell.Controls.Add(tabs, 0, 0);
            shell.Controls.Add(bottom, 0, 1);
            Controls.Add(shell);
        }

        private TabPage BuildServicesTab()
        {
            var page = NewPage("服务");

            var devGroup = new GroupBox
            {
                Text = "DevSpace",
                Location = new Point(18, 18),
                Size = new Size(900, 145)
            };
            devSpaceServiceLabel.SetBounds(18, 28, 850, 45);
            devSpaceServiceLabel.Font = new Font(Font, FontStyle.Bold);
            devGroup.Controls.Add(devSpaceServiceLabel);
            var startDev = AddButton(devGroup, "启动", 18, 86, 90);
            startDev.Click += delegate { RunServiceAction(supervisor.StartDevSpace); };
            var stopDev = AddButton(devGroup, "停止", 120, 86, 90);
            stopDev.Click += delegate { RunServiceAction(supervisor.StopDevSpace); };
            var restartDev = AddButton(devGroup, "重新启动", 222, 86, 110);
            restartDev.Click += delegate { RunServiceAction(supervisor.RestartDevSpace); };
            page.Controls.Add(devGroup);

            var cfGroup = new GroupBox
            {
                Text = "Cloudflare Tunnel",
                Location = new Point(18, 180),
                Size = new Size(900, 145)
            };
            cloudflareServiceLabel.SetBounds(18, 28, 850, 45);
            cloudflareServiceLabel.Font = new Font(Font, FontStyle.Bold);
            cfGroup.Controls.Add(cloudflareServiceLabel);
            var startCf = AddButton(cfGroup, "启动", 18, 86, 90);
            startCf.Click += delegate { RunServiceAction(supervisor.StartCloudflare); };
            var stopCf = AddButton(cfGroup, "停止", 120, 86, 90);
            stopCf.Click += delegate { RunServiceAction(supervisor.StopCloudflare); };
            var restartCf = AddButton(cfGroup, "重新启动", 222, 86, 110);
            restartCf.Click += delegate { RunServiceAction(supervisor.RestartCloudflare); };
            page.Controls.Add(cfGroup);

            var allGroup = new GroupBox
            {
                Text = "全部服务",
                Location = new Point(18, 342),
                Size = new Size(900, 115)
            };
            var startAll = AddButton(allGroup, "启动全部", 18, 40, 110);
            startAll.Click += delegate { RunServiceAction(supervisor.StartAll); };
            var stopAll = AddButton(allGroup, "停止全部", 140, 40, 110);
            stopAll.Click += delegate { RunServiceAction(supervisor.StopAll); };
            var restartAll = AddButton(allGroup, "重新启动全部", 262, 40, 130);
            restartAll.Click += delegate { RunServiceAction(supervisor.RestartAll); };
            var openLogs = AddButton(allGroup, "打开日志目录", 405, 40, 125);
            openLogs.Click += delegate { OpenDirectory(Path.Combine(platformRoot, "logs")); };
            var trayNote = new Label
            {
                Text = "关闭此窗口只会隐藏到托盘；只有托盘菜单“退出并停止服务”才会结束后台服务。",
                Location = new Point(550, 45),
                Size = new Size(325, 42),
                ForeColor = Color.DimGray
            };
            allGroup.Controls.Add(trayNote);
            page.Controls.Add(allGroup);

            AddLabel(page, "MCP 地址", 480, 18, 150);
            managedMcpUrlBox.SetBounds(18, 505, 700, 25);
            managedMcpUrlBox.ReadOnly = true;
            managedMcpUrlBox.BackColor = Color.White;
            page.Controls.Add(managedMcpUrlBox);
            var copyMcp = AddButton(page, "复制 MCP 地址", 730, 503, 120);
            copyMcp.Click += delegate
            {
                if (!string.IsNullOrWhiteSpace(managedMcpUrlBox.Text)) Clipboard.SetText(managedMcpUrlBox.Text);
            };
            var copyOwner = AddButton(page, "复制 Owner password", 730, 545, 150);
            copyOwner.Click += delegate
            {
                var value = supervisor.OwnerPassword;
                if (!string.IsNullOrWhiteSpace(value)) Clipboard.SetText(value);
                else MessageBox.Show("Owner password 尚未生成，请先启动 DevSpace。", "DevSpace Control Platform", MessageBoxButtons.OK, MessageBoxIcon.Information);
            };

            return page;
        }

        private TabPage BuildConnectionTab()
        {
            var page = NewPage("连接");

            AddLabel(page, "Allowed Roots（只开放真正需要的项目目录）", 18, 18, 500);
            rootsList.Location = new Point(18, 44);
            rootsList.Size = new Size(700, 150);
            page.Controls.Add(rootsList);

            var addRoot = AddButton(page, "添加目录", 730, 44, 100);
            addRoot.Click += delegate { AddAllowedRoot(); };
            var removeRoot = AddButton(page, "移除", 730, 82, 100);
            removeRoot.Click += delegate
            {
                if (rootsList.SelectedIndex >= 0) rootsList.Items.RemoveAt(rootsList.SelectedIndex);
            };
            var importLegacy = AddButton(page, "迁移旧配置", 730, 120, 100);
            importLegacy.Click += delegate { ImportLegacyQuickConfig(); };

            AddLabel(page, "本地端口", 215, 18, 120);
            portBox.Location = new Point(18, 240);
            portBox.Size = new Size(130, 25);
            portBox.Minimum = 1;
            portBox.Maximum = 65535;
            page.Controls.Add(portBox);

            AddLabel(page, "Tunnel 模式", 215, 180, 140);
            tunnelModeBox.Location = new Point(180, 240);
            tunnelModeBox.Size = new Size(150, 25);
            tunnelModeBox.DropDownStyle = ComboBoxStyle.DropDownList;
            tunnelModeBox.Items.AddRange(new object[] { "Quick", "Remote" });
            tunnelModeBox.SelectedIndexChanged += delegate { UpdateTunnelControls(); };
            page.Controls.Add(tunnelModeBox);

            autoStartBox.Text = "登录 Windows 后自动启动";
            autoStartBox.Location = new Point(380, 239);
            autoStartBox.Size = new Size(350, 26);
            page.Controls.Add(autoStartBox);

            hostnameBox.SetBounds(18, 315, 700, 25);
            AddLabeledText(page, "公网 hostname（例如 devspacev1.example.com，不含 https://）", hostnameBox, 288);

            AddLabel(page, "Cloudflare Tunnel Token（Remote 模式；只保存在受保护 secrets 文件）", 355, 18, 760);
            cloudflareTokenBox.SetBounds(18, 382, 700, 25);
            cloudflareTokenBox.UseSystemPasswordChar = true;
            page.Controls.Add(cloudflareTokenBox);
            var saveToken = AddButton(page, "保存 Token", 730, 379, 100);
            saveToken.Click += delegate { SaveCloudflareToken(); };
            cloudflareTokenStatusLabel.SetBounds(18, 416, 880, 44);
            cloudflareTokenStatusLabel.ForeColor = Color.DimGray;
            page.Controls.Add(cloudflareTokenStatusLabel);

            var compatibilityNote = AddLabel(page,
                "旧 Named Tunnel 的 UUID / credentials JSON / YAML 仍可从旧配置迁移并保存在兼容层，但 Remote Tunnel 日常使用不需要这些文件路径，因此不再显示。",
                478, 18, 880);
            compatibilityNote.Size = new Size(880, 46);
            compatibilityNote.ForeColor = Color.DimGray;

            return page;
        }

        private TabPage BuildDevSpaceTab()
        {
            var page = NewPage("DevSpace");

            AddLabel(page, "运行时", 18, 18, 160);
            versionLabel.SetBounds(18, 44, 900, 45);
            versionLabel.Font = new Font(Font, FontStyle.Bold);
            page.Controls.Add(versionLabel);

            AddLabel(page, "Tool mode", 105, 18, 160);
            toolModeBox.SetBounds(18, 130, 180, 25);
            toolModeBox.DropDownStyle = ComboBoxStyle.DropDownList;
            toolModeBox.SelectedIndexChanged += delegate { UpdateToolModeDescription(); };
            page.Controls.Add(toolModeBox);

            reviewUiBox.Text = "启用 Change Review / show_changes UI";
            reviewUiBox.SetBounds(240, 129, 300, 26);
            page.Controls.Add(reviewUiBox);

            skillsBox.Text = "启用 Agent Skills 发现";
            skillsBox.SetBounds(18, 190, 230, 26);
            page.Controls.Add(skillsBox);

            AddLabel(page, "额外 Skill 路径（每行一个，可留空）", 230, 18, 350);
            skillPathsBox.SetBounds(18, 257, 700, 100);
            skillPathsBox.Multiline = true;
            skillPathsBox.ScrollBars = ScrollBars.Vertical;
            page.Controls.Add(skillPathsBox);

            subagentLabel.SetBounds(18, 395, 900, 58);
            subagentLabel.BorderStyle = BorderStyle.FixedSingle;
            subagentLabel.Padding = new Padding(8);
            subagentLabel.Text = "Subagents：关闭（当前长期目标明确不启用本地 harness delegation）。\r\n控制平台会在 1.0.x 和 1.1.x 的实际有效配置中同时验证它保持关闭。";
            page.Controls.Add(subagentLabel);

            managedConfigLabel.SetBounds(18, 475, 900, 60);
            managedConfigLabel.ForeColor = Color.DimGray;
            managedConfigLabel.Text = "Managed config：" + configDirectory +
                "\r\n开发/验证期间不会写入 %USERPROFILE%\\.devspace，也不会复用旧 QuickConfig runtime/state。";
            page.Controls.Add(managedConfigLabel);

            return page;
        }

        private TabPage BuildDiagnosticsTab()
        {
            var page = NewPage("日志与诊断");

            AddLabel(page, "Log level", 18, 18, 120);
            logLevelBox.SetBounds(18, 44, 160, 25);
            logLevelBox.DropDownStyle = ComboBoxStyle.DropDownList;
            logLevelBox.Items.AddRange(new object[] { "silent", "error", "warn", "info", "debug" });
            page.Controls.Add(logLevelBox);

            AddLabel(page, "Log format", 18, 210, 120);
            logFormatBox.SetBounds(210, 44, 160, 25);
            logFormatBox.DropDownStyle = ComboBoxStyle.DropDownList;
            logFormatBox.Items.AddRange(new object[] { "pretty", "json" });
            page.Controls.Add(logFormatBox);

            logRequestsBox.Text = "Request logs";
            logRequestsBox.SetBounds(18, 92, 160, 25);
            logToolCallsBox.Text = "Tool-call logs";
            logToolCallsBox.SetBounds(190, 92, 160, 25);
            logShellCommandsBox.Text = "Shell command logs（可能包含敏感参数）";
            logShellCommandsBox.SetBounds(370, 92, 330, 25);
            page.Controls.Add(logRequestsBox);
            page.Controls.Add(logToolCallsBox);
            page.Controls.Add(logShellCommandsBox);

            var validate = AddButton(page, "验证配置", 18, 140, 110);
            validate.Click += delegate { ValidateCurrentConfiguration(true); };
            var doctor = AddButton(page, "运行 doctor", 140, 140, 110);
            doctor.Click += delegate { RunDoctor(); };
            var configGet = AddButton(page, "查看实际配置", 262, 140, 120);
            configGet.Click += delegate { RunConfigGet(); };
            var openState = AddButton(page, "打开 state 目录", 394, 140, 120);
            openState.Click += delegate { OpenDirectory(Path.Combine(platformRoot, "state")); };

            AddLabel(page, "诊断结果（验证配置 / doctor / 实际配置 / 回滚结果）", 183, 18, 520);
            diagnosticsBox.SetBounds(18, 207, 900, 145);
            diagnosticsBox.Multiline = true;
            diagnosticsBox.ScrollBars = ScrollBars.Vertical;
            diagnosticsBox.ReadOnly = true;
            diagnosticsBox.Font = new Font("Microsoft YaHei UI", 9F);
            diagnosticsBox.WordWrap = true;
            page.Controls.Add(diagnosticsBox);

            AddLabel(page, "GPT 会话日志（按 workspaceId 隔离）", 350, 18, 300);
            conversationLogSelector.SetBounds(18, 375, 420, 28);
            conversationLogSelector.DropDownStyle = ComboBoxStyle.DropDownList;
            conversationLogSelector.SelectedIndexChanged += delegate
            {
                if (!updatingConversationLogSelector) RefreshConversationLogView();
            };
            page.Controls.Add(conversationLogSelector);

            latestToolCallLabel.SetBounds(455, 377, 463, 24);
            latestToolCallLabel.ForeColor = Color.DimGray;
            latestToolCallLabel.AutoEllipsis = true;
            page.Controls.Add(latestToolCallLabel);

            conversationLogBox.SetBounds(18, 410, 900, 150);
            conversationLogBox.Multiline = true;
            conversationLogBox.ScrollBars = ScrollBars.Vertical;
            conversationLogBox.ReadOnly = true;
            conversationLogBox.Font = new Font("Microsoft YaHei UI", 9F);
            conversationLogBox.WordWrap = true;
            ForwardMouseWheelToPage(conversationLogBox, page);
            page.Controls.Add(conversationLogBox);

            AddLabel(page, "服务后台日志（DevSpace 进程 / Cloudflare / 无法安全归属到单一 GPT 会话的事件）", 575, 18, 760);
            liveLogBox.SetBounds(18, 602, 900, 145);
            liveLogBox.Multiline = true;
            liveLogBox.ScrollBars = ScrollBars.Vertical;
            liveLogBox.ReadOnly = true;
            liveLogBox.Font = new Font("Microsoft YaHei UI", 9F);
            liveLogBox.WordWrap = true;
            ForwardMouseWheelToPage(liveLogBox, page);
            page.Controls.Add(liveLogBox);

            ForwardMouseWheelToPage(diagnosticsBox, page);

            return page;
        }

        private TabPage BuildReviewHistoryTab()
        {
            var page = NewPage("项目 / Git");
            var header = new Panel { Location = new Point(18, 10), Size = new Size(900, 108) };
            AddLabel(header, "项目", 8, 0, 45);
            reviewWorkspaceBox.SetBounds(52, 4, 520, 28);
            reviewWorkspaceBox.DropDownStyle = ComboBoxStyle.DropDownList;
            reviewWorkspaceBox.DropDownWidth = 520;
            reviewWorkspaceBox.MaxDropDownItems = 10;
            reviewWorkspaceBox.SelectedIndexChanged += delegate
            {
                if (!updatingReviewWorkspaceBox) RefreshReviewHistory();
            };
            header.Controls.Add(reviewWorkspaceBox);

            reviewWorkspaceLabel.SetBounds(0, 38, 900, 24);
            reviewWorkspaceLabel.ForeColor = Color.DimGray;
            reviewWorkspaceLabel.AutoEllipsis = true;
            header.Controls.Add(reviewWorkspaceLabel);

            gitRepositoryStatusLabel.SetBounds(0, 60, 900, 24);
            gitRepositoryStatusLabel.ForeColor = Color.DimGray;
            gitRepositoryStatusLabel.AutoEllipsis = true;
            header.Controls.Add(gitRepositoryStatusLabel);

            var note = AddLabel(
                header,
                "项目归属由模型按真实仓库边界判断；无 Git 时由模型在正确项目根目录初始化。下方同时显示真实本地 Git 提交与 DevSpace Review 版本。",
                82,
                0,
                900);
            note.ForeColor = Color.DimGray;
            page.Controls.Add(header);

            AddLabel(page, "本地 Git 提交", 18, 122, 180);
            gitHistoryGrid.SetBounds(18, 144, 900, 150);
            gitHistoryGrid.BorderStyle = BorderStyle.Fixed3D;
            gitHistoryGrid.ReadOnly = true;
            gitHistoryGrid.AllowUserToAddRows = false;
            gitHistoryGrid.AllowUserToDeleteRows = false;
            gitHistoryGrid.AllowUserToResizeRows = false;
            gitHistoryGrid.MultiSelect = false;
            gitHistoryGrid.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
            gitHistoryGrid.RowHeadersVisible = false;
            gitHistoryGrid.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
            gitHistoryGrid.ScrollBars = ScrollBars.Vertical;
            gitHistoryGrid.BackgroundColor = SystemColors.Window;
            gitHistoryGrid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Commit", HeaderText = "Commit", FillWeight = 16 });
            gitHistoryGrid.Columns.Add(new DataGridViewTextBoxColumn { Name = "GitTime", HeaderText = "时间", FillWeight = 24 });
            gitHistoryGrid.Columns.Add(new DataGridViewTextBoxColumn { Name = "GitSummary", HeaderText = "说明", FillWeight = 60 });
            page.Controls.Add(gitHistoryGrid);

            AddLabel(page, "DevSpace Review 版本", 18, 302, 220);
            reviewHistoryGrid.SetBounds(18, 324, 900, 250);
            reviewHistoryGrid.BorderStyle = BorderStyle.Fixed3D;
            reviewHistoryGrid.ReadOnly = true;
            reviewHistoryGrid.AllowUserToAddRows = false;
            reviewHistoryGrid.AllowUserToDeleteRows = false;
            reviewHistoryGrid.AllowUserToResizeRows = false;
            reviewHistoryGrid.MultiSelect = false;
            reviewHistoryGrid.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
            reviewHistoryGrid.RowHeadersVisible = false;
            reviewHistoryGrid.AutoSizeRowsMode = DataGridViewAutoSizeRowsMode.AllCells;
            reviewHistoryGrid.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
            reviewHistoryGrid.ScrollBars = ScrollBars.Vertical;
            reviewHistoryGrid.BackgroundColor = SystemColors.Window;
            reviewHistoryGrid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Status", HeaderText = "状态", FillWeight = 10 });
            reviewHistoryGrid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Version", HeaderText = "版本", FillWeight = 8 });
            reviewHistoryGrid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Time", HeaderText = "时间", FillWeight = 20 });
            reviewHistoryGrid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Conversation", HeaderText = "来源会话", FillWeight = 22 });
            reviewHistoryGrid.Columns.Add(new DataGridViewTextBoxColumn
            {
                Name = "Summary",
                HeaderText = "原因 / 处理",
                FillWeight = 40,
                DefaultCellStyle = new DataGridViewCellStyle { WrapMode = DataGridViewTriState.True }
            });
            reviewHistoryGrid.SelectionChanged += delegate { UpdateReviewRollbackSelection(); };
            page.Controls.Add(reviewHistoryGrid);

            var footer = new Panel { Location = new Point(18, 582), Size = new Size(900, 72) };
            var refresh = AddButton(footer, "刷新版本", 0, 12, 110);
            refresh.Click += delegate { RefreshReviewHistory(); };

            rollbackSelectedReviewButton.Text = "回滚到选中版本";
            rollbackSelectedReviewButton.SetBounds(122, 12, 150, 30);
            rollbackSelectedReviewButton.Click += delegate { RollbackToSelectedReview(); };
            footer.Controls.Add(rollbackSelectedReviewButton);

            reviewHistoryStatusLabel.SetBounds(292, 8, 608, 52);
            reviewHistoryStatusLabel.ForeColor = Color.DimGray;
            footer.Controls.Add(reviewHistoryStatusLabel);
            page.Controls.Add(footer);

            return page;
        }

        private TabPage BuildHistoryTab()
        {
            var page = NewPage("平台配置历史");
            historyList.SetBounds(18, 44, 330, 490);
            historyList.SelectedIndexChanged += delegate { PreviewSelectedHistory(); };
            page.Controls.Add(historyList);
            AddLabel(page, "最近配置快照", 18, 18, 200);

            historyPreviewBox.SetBounds(365, 44, 550, 490);
            historyPreviewBox.Multiline = true;
            historyPreviewBox.ScrollBars = ScrollBars.Both;
            historyPreviewBox.ReadOnly = true;
            historyPreviewBox.Font = new Font("Consolas", 9F);
            historyPreviewBox.WordWrap = false;
            page.Controls.Add(historyPreviewBox);

            var refresh = AddButton(page, "刷新", 18, 550, 90);
            refresh.Click += delegate { RefreshHistory(); };
            var load = AddButton(page, "载入到表单", 365, 550, 120);
            load.Click += delegate { LoadSelectedHistoryIntoForm(); };
            var note = AddLabel(page,
                "这里只保存 ControlPlatform settings，不包含项目代码。载入历史只填充页面；再次点击“保存配置”才会应用。",
                595, 18, 880);
            note.ForeColor = Color.DimGray;

            return page;
        }

        private void LoadState()
        {
            try
            {
                settings = PlatformSettingsStore.Load(settingsPath, platformRoot);
            }
            catch (Exception exception)
            {
                settings = PlatformSettings.CreateDefault(platformRoot);
                statusLabel.Text = "settings.json 无法读取，已加载默认值：" + exception.Message;
            }

            PopulateForm(settings);
            DetectDefaultPackageRoot();
            DetectVersion(false);
            RefreshHistory();
            if (string.IsNullOrWhiteSpace(statusLabel.Text))
            {
                statusLabel.Text = "当前为独立开发实例；不会启动或修改旧 DevSpaceQuickTunnelTray。";
            }
        }

        private void PopulateForm(PlatformSettings value)
        {
            rootsList.Items.Clear();
            foreach (var root in value.AllowedRoots ?? new List<string>()) rootsList.Items.Add(root);
            portBox.Value = Math.Max(1, Math.Min(65535, value.LocalPort));
            tunnelModeBox.SelectedItem = string.IsNullOrWhiteSpace(value.TunnelMode) ? "未配置" : value.TunnelMode;
            if (tunnelModeBox.SelectedIndex < 0) tunnelModeBox.SelectedIndex = 0;
            hostnameBox.Text = value.FixedHostname ?? string.Empty;
            tunnelIdBox.Text = value.NamedTunnelIdOrName ?? string.Empty;
            credentialsBox.Text = value.CredentialsFilePath ?? string.Empty;
            cloudflaredConfigBox.Text = value.CloudflaredConfigPath ?? string.Empty;
            autoStartBox.Checked = value.AutoStart;
            reviewUiBox.Checked = value.ReviewUiEnabled;
            skillsBox.Checked = value.SkillsEnabled;
            skillPathsBox.Lines = (value.SkillPaths ?? new List<string>()).ToArray();
            logLevelBox.SelectedItem = value.LogLevel ?? "info";
            logFormatBox.SelectedItem = value.LogFormat ?? "pretty";
            logRequestsBox.Checked = value.LogRequests;
            logToolCallsBox.Checked = value.LogToolCalls;
            logShellCommandsBox.Checked = value.LogShellCommands;
            UpdateTunnelControls();
            RefreshCloudflareTokenStatus();
        }

        private PlatformSettings ReadForm()
        {
            return new PlatformSettings
            {
                SchemaVersion = 1,
                AllowedRoots = rootsList.Items.Cast<object>().Select(Convert.ToString).Where(v => !string.IsNullOrWhiteSpace(v)).ToList(),
                LocalPort = Decimal.ToInt32(portBox.Value),
                TunnelMode = string.Equals(Convert.ToString(tunnelModeBox.SelectedItem), "未配置", StringComparison.OrdinalIgnoreCase)
                    ? string.Empty
                    : Convert.ToString(tunnelModeBox.SelectedItem),
                FixedHostname = hostnameBox.Text.Trim(),
                NamedTunnelIdOrName = tunnelIdBox.Text.Trim(),
                CredentialsFilePath = credentialsBox.Text.Trim(),
                CloudflaredConfigPath = cloudflaredConfigBox.Text.Trim(),
                AutoStart = autoStartBox.Checked,
                ToolMode = Convert.ToString(toolModeBox.SelectedItem),
                ReviewUiEnabled = reviewUiBox.Checked,
                SkillsEnabled = skillsBox.Checked,
                SkillPaths = skillPathsBox.Lines.Select(v => v.Trim()).Where(v => v.Length > 0).ToList(),
                LogLevel = Convert.ToString(logLevelBox.SelectedItem),
                LogFormat = Convert.ToString(logFormatBox.SelectedItem),
                LogRequests = logRequestsBox.Checked,
                LogToolCalls = logToolCallsBox.Checked,
                LogShellCommands = logShellCommandsBox.Checked
            };
        }

        private void SaveCurrentSettings()
        {
            try
            {
                var candidate = ReadForm();
                if (File.Exists(settingsPath)) history.Snapshot(settingsPath, detectedVersion);
                var plan = ValidateCandidate(candidate);
                PlatformSettingsStore.Save(settingsPath, candidate);
                DevSpaceConfiguration.WritePlan(plan);
                supervisor.ApplyWindowsAutoStart(candidate.AutoStart);
                settings = candidate;
                RefreshHistory();
                statusLabel.Text = "配置已保存；运行中的服务如需使用新配置，请在“服务”页重新启动。";
                diagnosticsBox.Text = "PASS\r\n" +
                    "Platform settings: " + settingsPath + "\r\n" +
                    "DevSpace config: " + plan.ConfigPath + "\r\n" +
                    "Version: " + plan.Version;
            }
            catch (Exception exception)
            {
                MessageBox.Show(exception.Message, "无法保存配置", MessageBoxButtons.OK, MessageBoxIcon.Error);
                statusLabel.Text = "配置未保存。";
            }
        }

        internal void RefreshServiceStatus()
        {
            if (IsDisposed) return;
            devSpaceServiceLabel.Text = "状态：" + supervisor.DevSpaceStatus;
            cloudflareServiceLabel.Text = "状态：" + supervisor.CloudflareStatus;
            managedMcpUrlBox.Text = supervisor.McpUrl;
            RefreshLiveDiagnostics();
        }

        private void RefreshLiveDiagnostics()
        {
            RefreshConversationLogChoices();
            RefreshConversationLogView();

            var text = supervisor.RecentServiceLogText;
            if (!string.Equals(liveLogBox.Text, text, StringComparison.Ordinal))
            {
                var atEnd = liveLogBox.SelectionStart >= Math.Max(0, liveLogBox.TextLength - 2);
                liveLogBox.Text = text;
                if (atEnd)
                {
                    liveLogBox.SelectionStart = liveLogBox.TextLength;
                    liveLogBox.ScrollToCaret();
                }
            }
        }

        private void RefreshConversationLogChoices()
        {
            var current = conversationLogSelector.SelectedItem as DevSpaceConversationInfo;
            var currentId = current == null ? string.Empty : current.WorkspaceId;
            var conversations = supervisor.KnownConversations;
            var existingIds = conversationLogSelector.Items.Cast<object>()
                .OfType<DevSpaceConversationInfo>()
                .Select(v => v.WorkspaceId)
                .ToArray();
            var nextIds = conversations.Select(v => v.WorkspaceId).ToArray();
            if (existingIds.SequenceEqual(nextIds, StringComparer.OrdinalIgnoreCase)) return;

            updatingConversationLogSelector = true;
            try
            {
                conversationLogSelector.Items.Clear();
                foreach (var conversation in conversations) conversationLogSelector.Items.Add(conversation);
                var selected = conversations.FirstOrDefault(v => string.Equals(v.WorkspaceId, currentId, StringComparison.OrdinalIgnoreCase));
                if (selected == null)
                    selected = conversations.FirstOrDefault(v => string.Equals(v.WorkspaceId, supervisor.LatestWorkspaceId, StringComparison.OrdinalIgnoreCase));
                if (selected == null) selected = conversations.FirstOrDefault();
                if (selected != null) conversationLogSelector.SelectedItem = selected;
            }
            finally
            {
                updatingConversationLogSelector = false;
            }
        }

        private void RefreshConversationLogView()
        {
            var conversation = conversationLogSelector.SelectedItem as DevSpaceConversationInfo;
            if (conversation == null)
            {
                latestToolCallLabel.Text = "尚未观察到 GPT 会话 workspace。";
                conversationLogBox.Text = string.Empty;
                return;
            }

            latestToolCallLabel.Text = "最近工具：" + supervisor.ConversationLatestTool(conversation.WorkspaceId) +
                "  |  " + conversation.WorkspaceId;
            var text = supervisor.ConversationLogText(conversation.WorkspaceId);
            if (!string.Equals(conversationLogBox.Text, text, StringComparison.Ordinal))
            {
                var atEnd = conversationLogBox.SelectionStart >= Math.Max(0, conversationLogBox.TextLength - 2);
                conversationLogBox.Text = text;
                if (atEnd)
                {
                    conversationLogBox.SelectionStart = conversationLogBox.TextLength;
                    conversationLogBox.ScrollToCaret();
                }
            }
        }

        private void RefreshReviewHistory()
        {
            lastReviewHistoryRefreshUtc = DateTime.UtcNow;
            RefreshReviewWorkspaceChoices();
            var workspacePath = SelectedReviewWorkspacePath();
            reviewVersions.Clear();
            reviewHistoryGrid.Rows.Clear();
            gitHistoryGrid.Rows.Clear();
            rollbackSelectedReviewButton.Enabled = false;
            if (string.IsNullOrWhiteSpace(workspacePath))
            {
                reviewWorkspaceLabel.Text = "Workspace：尚未观察到 DevSpace workspace";
                gitRepositoryStatusLabel.Text = "Git：尚无项目";
                reviewHistoryStatusLabel.Text = "先在 GPT 中打开 workspace；模型会判断项目归属，无 Git 时在正确项目根目录初始化。";
                return;
            }

            try
            {
                var repository = DevSpaceReviewRollback.DescribeRepository(workspacePath);
                reviewWorkspaceLabel.Text = (repository.IsRepository ? "项目根目录：" : "Workspace：") + repository.Root;
                if (!repository.IsRepository)
                {
                    gitRepositoryStatusLabel.Text = "Git：未初始化；等待模型确认项目边界后执行 git init。";
                    reviewHistoryStatusLabel.Text = "当前没有 Git repository，因此不会创建 Review 版本。";
                    return;
                }

                gitRepositoryStatusLabel.Text = "Git：" + repository.Branch + " @ " + repository.Head +
                    " · " + repository.CommitCount + " commits · " + (repository.IsDirty ? "有未提交修改" : "clean") +
                    (string.IsNullOrWhiteSpace(repository.HeadSummary) ? string.Empty : " · " + repository.HeadSummary);
                foreach (var commit in DevSpaceReviewRollback.ListRecentCommits(repository.Root, 12))
                {
                    gitHistoryGrid.Rows.Add(
                        commit.ShortCommit,
                        commit.CreatedAt == DateTimeOffset.MinValue ? "-" : commit.CreatedAt.LocalDateTime.ToString("yyyy-MM-dd HH:mm:ss"),
                        commit.Summary);
                }

                var history = DevSpaceReviewRollback.ListVersions(repository.Root);
                foreach (var version in history.Versions.OrderByDescending(v => v.CreatedAt))
                {
                    reviewVersions.Add(version);
                    var rowIndex = reviewHistoryGrid.Rows.Add(
                        version.Status,
                        version.Version,
                        version.CreatedAt == DateTimeOffset.MinValue ? "-" : version.CreatedAt.LocalDateTime.ToString("yyyy-MM-dd HH:mm:ss"),
                        supervisor.ConversationDisplayName(version.WorkspaceId),
                        version.Summary);
                    var row = reviewHistoryGrid.Rows[rowIndex];
                    row.Tag = version;
                    if (version.IsCurrent) row.DefaultCellStyle.Font = new Font(reviewHistoryGrid.Font, FontStyle.Bold);
                }
                var current = history.Versions.FirstOrDefault(v => v.IsCurrent);
                reviewHistoryStatusLabel.Text = current == null
                    ? "尚无版本。完成一次 show_changes 后会出现 V1。"
                    : "当前 " + current.Version + "。选择更早的“可回滚”版本，可以一次撤销中间多轮 Review。";
                UpdateReviewRollbackSelection();
            }
            catch (Exception exception)
            {
                reviewWorkspaceLabel.Text = "Workspace：" + workspacePath;
                reviewHistoryStatusLabel.Text = "无法读取代码版本：" + exception.Message;
            }
        }

        private void RefreshReviewWorkspaceChoices()
        {
            var selectedChoice = reviewWorkspaceBox.SelectedItem as ReviewWorkspaceChoice;
            var selected = selectedChoice == null ? string.Empty : selectedChoice.Path;
            var preferred = supervisor.LatestReviewedWorkspacePath;
            if (string.IsNullOrWhiteSpace(preferred)) preferred = supervisor.LatestWorkspacePath;
            var paths = supervisor.KnownWorkspacePaths.ToList();
            if (!string.IsNullOrWhiteSpace(preferred) && !paths.Contains(preferred, StringComparer.OrdinalIgnoreCase))
                paths.Add(preferred);
            paths = paths.Where(Directory.Exists).Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(Path.GetFileName).ThenBy(v => v).ToList();

            updatingReviewWorkspaceBox = true;
            try
            {
                reviewWorkspaceBox.Items.Clear();
                reviewWorkspaceBox.Enabled = paths.Count > 0;
                if (paths.Count == 0)
                {
                    reviewWorkspaceBox.Items.Add("尚未检测到 Git 项目");
                    reviewWorkspaceBox.SelectedIndex = 0;
                    return;
                }
                foreach (var path in paths)
                {
                    reviewWorkspaceBox.Items.Add(new ReviewWorkspaceChoice
                    {
                        Path = path,
                        DisplayName = ReviewWorkspaceDisplayName(path)
                    });
                }
                var next = paths.FirstOrDefault(v => string.Equals(v, selected, StringComparison.OrdinalIgnoreCase));
                if (next == null) next = paths.FirstOrDefault(v => string.Equals(v, preferred, StringComparison.OrdinalIgnoreCase));
                if (next == null) next = paths.FirstOrDefault();
                if (next != null)
                {
                    var item = reviewWorkspaceBox.Items.Cast<object>()
                        .OfType<ReviewWorkspaceChoice>()
                        .FirstOrDefault(v => string.Equals(v.Path, next, StringComparison.OrdinalIgnoreCase));
                    if (item != null) reviewWorkspaceBox.SelectedItem = item;
                }
            }
            finally
            {
                updatingReviewWorkspaceBox = false;
            }
        }

        private string SelectedReviewWorkspacePath()
        {
            if (!reviewWorkspaceBox.Enabled) return string.Empty;
            var choice = reviewWorkspaceBox.SelectedItem as ReviewWorkspaceChoice;
            return choice == null ? string.Empty : choice.Path;
        }

        private static string ReviewWorkspaceDisplayName(string path)
        {
            var repository = DevSpaceReviewRollback.DescribeRepository(path);
            var normalized = (repository.Root ?? path ?? string.Empty).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var name = Path.GetFileName(normalized);
            if (string.IsNullOrWhiteSpace(name)) return normalized;
            var display = repository.IsRepository
                ? name + "  —  " + repository.Branch + " @ " + repository.Head + (repository.IsDirty ? " *" : string.Empty)
                : name + "  —  未初始化 Git";
            return display.Length <= 46 ? display : display.Substring(0, 43) + "...";
        }

        private static void ForwardMouseWheelToPage(Control control, ScrollableControl page)
        {
            control.MouseWheel += delegate(object sender, MouseEventArgs eventArgs)
            {
                if (!page.VerticalScroll.Visible) return;
                var current = -page.AutoScrollPosition.Y;
                var maximum = Math.Max(0, page.VerticalScroll.Maximum - page.ClientSize.Height);
                var next = Math.Max(0, Math.Min(maximum, current - eventArgs.Delta));
                if (next == current) return;
                page.AutoScrollPosition = new Point(0, next);
                var handled = eventArgs as HandledMouseEventArgs;
                if (handled != null) handled.Handled = true;
            };
        }

        private void UpdateReviewRollbackSelection()
        {
            var version = SelectedReviewVersion();
            rollbackSelectedReviewButton.Enabled = version != null && version.IsActive && !version.IsCurrent;
            if (version == null) return;
            if (version.IsCurrent)
                reviewHistoryStatusLabel.Text = version.Version + " 是当前版本。";
            else if (!version.IsActive)
                reviewHistoryStatusLabel.Text = version.Version + " 属于已回滚分支，当前仅用于审计。";
            else
                reviewHistoryStatusLabel.Text = "回滚到 " + version.Version + " 将一次撤销后续 " + version.RollbackSteps + " 个版本。";
        }

        private DevSpaceReviewVersion SelectedReviewVersion()
        {
            return reviewHistoryGrid.SelectedRows.Count == 1
                ? reviewHistoryGrid.SelectedRows[0].Tag as DevSpaceReviewVersion
                : null;
        }

        private void RollbackToSelectedReview()
        {
            var target = SelectedReviewVersion();
            var workspacePath = SelectedReviewWorkspacePath();
            if (target == null || string.IsNullOrWhiteSpace(workspacePath)) return;

            var confirm = MessageBox.Show(
                "将代码一次回滚到：\r\n\r\n" +
                target.Version + "  " + target.CreatedAt.LocalDateTime.ToString("yyyy-MM-dd HH:mm:ss") + "\r\n" +
                target.Summary + "\r\n\r\n" +
                "预计撤销后续 " + target.RollbackSteps + " 个版本。\r\n" +
                "操作只反向应用版本差异；若当前文件已有冲突修改会拒绝，不执行 git reset --hard。",
                "确认回滚到 " + target.Version,
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning,
                MessageBoxDefaultButton.Button2);
            if (confirm != DialogResult.Yes) return;

            try
            {
                var result = DevSpaceReviewRollback.RollbackTo(workspacePath, target.ReviewRef);
                ManagedAgentInstructions.SetRollbackNotice(platformRoot, workspacePath, result.Target, result.RolledBackReviews);
                var restartWarning = string.Empty;
                try { supervisor.RestartDevSpace(); }
                catch (Exception exception) { restartWarning = "\r\nDevSpace 自动重启失败：" + exception.Message; }
                diagnosticsBox.Text = "ROLLBACK PASS\r\n" + result.Message +
                    "\r\n下一次 GPT 重新打开该 workspace 时会自动收到一次“已回滚到 " + result.Target.Version + "”提示。" +
                    restartWarning;
                statusLabel.Text = "已回滚到 " + result.Target.Version + "。DevSpace 已刷新上下文。";
                RefreshReviewHistory();
            }
            catch (Exception exception)
            {
                MessageBox.Show(exception.Message, "回滚被拒绝或失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                diagnosticsBox.Text = "ROLLBACK FAIL\r\n" + exception.Message;
                statusLabel.Text = "代码回滚未执行。";
            }
        }

        private void RunServiceAction(Action action)
        {
            try
            {
                action();
                RefreshServiceStatus();
                statusLabel.Text = "服务操作完成。";
            }
            catch (Exception exception)
            {
                MessageBox.Show(exception.Message, "服务操作失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                RefreshServiceStatus();
                statusLabel.Text = "服务操作失败。";
            }
        }

        internal void AllowApplicationClose()
        {
            allowApplicationClose = true;
        }

        protected override void OnFormClosing(FormClosingEventArgs eventArgs)
        {
            if (!allowApplicationClose && eventArgs.CloseReason == CloseReason.UserClosing)
            {
                eventArgs.Cancel = true;
                Hide();
                return;
            }
            base.OnFormClosing(eventArgs);
        }

        private DevSpaceLaunchPlan ValidateCandidate(PlatformSettings candidate)
        {
            if (detectedVersion == null) throw new InvalidOperationException("请先选择 DevSpace package 并检测版本。");
            ValidateTunnelSettings(candidate);
            if (string.Equals(candidate.TunnelMode, "Remote", StringComparison.OrdinalIgnoreCase) &&
                !CloudflareTunnelSecretStore.HasToken(platformRoot))
            {
                throw new InvalidDataException("Remote Tunnel 需要先在“连接”页填写并保存 Cloudflare Tunnel Token。");
            }
            var managed = candidate.ToManagedDevSpaceSettings(platformRoot, PublicBaseUrlFor(candidate));
            var plan = DevSpaceConfiguration.BuildPlan(detectedVersion, managed, configDirectory);
            RuntimeResolver.AddRuntimeToolPaths(plan.EnvironmentVariables, platformRoot);
            var report = DevSpaceEffectiveStateVerifier.Verify(plan, platformRoot);
            if (!report.IsSafe) throw new InvalidDataException(string.Join("\r\n", report.Errors.ToArray()));
            if (report.Warnings.Count > 0) diagnosticsBox.Text = "Warnings:\r\n" + string.Join("\r\n", report.Warnings.ToArray());
            return plan;
        }

        private void ValidateCurrentConfiguration(bool showSuccess)
        {
            try
            {
                var plan = ValidateCandidate(ReadForm());
                var serenaExe = Path.Combine(RuntimeResolver.ResolveSerenaBinDirectory(platformRoot), "serena.exe");
                diagnosticsBox.Text = "PASS\r\n" +
                    "DevSpace " + plan.Version.Raw + "\r\n" +
                    "Config family: " + plan.Version.Family + "\r\n" +
                    "Managed config: " + plan.ConfigPath + "\r\n" +
                    "Serena semantic backend: " + (File.Exists(serenaExe) ? "available" : "not installed") + "\r\n" +
                    "Subagents: disabled\r\n" +
                    "Allowed roots: " + rootsList.Items.Count;
                if (showSuccess) statusLabel.Text = "配置验证通过。";
            }
            catch (Exception exception)
            {
                diagnosticsBox.Text = "FAIL\r\n" + exception.Message;
                statusLabel.Text = "配置验证失败。";
            }
        }

        private void RunDoctor()
        {
            RunManagedCli(delegate(DevSpaceCliRunner runner) { return runner.Doctor(); });
        }

        private void RunConfigGet()
        {
            RunManagedCli(delegate(DevSpaceCliRunner runner) { return runner.ConfigGet(); });
        }

        private void RunManagedCli(Func<DevSpaceCliRunner, DevSpaceCommandResult> run)
        {
            try
            {
                var plan = ValidateCandidate(ReadForm());
                var cli = ResolveCliPath();
                var node = RuntimeResolver.ResolveNodePath(platformRoot);
                DevSpaceConfiguration.WritePlan(plan);
                var runner = new DevSpaceCliRunner(node, cli, plan, platformRoot);
                var result = run(runner);
                diagnosticsBox.Text =
                    "Exit code: " + result.ExitCode + "\r\n\r\n" +
                    result.StandardOutput +
                    (string.IsNullOrWhiteSpace(result.StandardError) ? string.Empty : "\r\n\r\nSTDERR\r\n" + result.StandardError);
                statusLabel.Text = result.Success ? "DevSpace CLI 诊断完成。" : "DevSpace CLI 返回错误。";
            }
            catch (Exception exception)
            {
                diagnosticsBox.Text = "FAIL\r\n" + exception.Message;
                statusLabel.Text = "DevSpace CLI 诊断失败。";
            }
        }

        private void DetectDefaultPackageRoot()
        {
            if (!string.IsNullOrWhiteSpace(packageRootBox.Text)) return;
            var candidates = new[]
            {
                Path.Combine(platformRoot, "runtime", "devspace", "node_modules", "@waishnav", "devspace"),
                Path.Combine(Directory.GetParent(platformRoot).FullName, "runtime", "devspace", "node_modules", "@waishnav", "devspace")
            };
            foreach (var runtimePackage in candidates)
            {
                if (!File.Exists(Path.Combine(runtimePackage, "package.json"))) continue;
                packageRootBox.Text = runtimePackage;
                return;
            }
        }

        private void DetectVersion(bool showError)
        {
            try
            {
                var root = packageRootBox.Text.Trim();
                var packageJson = Path.Combine(root, "package.json");
                detectedVersion = DevSpaceVersion.FromPackageJson(packageJson);
                detectedPackageRoot = Path.GetFullPath(root);
                versionLabel.Text = "检测到 DevSpace " + detectedVersion.Raw + "    配置族：" + detectedVersion.Family;
                ConfigureToolModes();
                statusLabel.Text = "DevSpace 版本检测完成。";
            }
            catch (Exception exception)
            {
                detectedVersion = null;
                detectedPackageRoot = null;
                versionLabel.Text = "尚未检测到可支持的 DevSpace package。";
                ConfigureToolModes();
                if (showError) MessageBox.Show(exception.Message, "版本检测失败", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void ConfigureToolModes()
        {
            var requested = settings == null ? "codex" : settings.ToolMode;
            toolModeBox.Items.Clear();
            if (detectedVersion != null && detectedVersion.Family == DevSpaceConfigFamily.Legacy10)
            {
                toolModeBox.Items.AddRange(new object[] { "minimal", "full", "codex" });
            }
            else
            {
                toolModeBox.Items.AddRange(new object[] { "codex", "claude" });
            }
            if (toolModeBox.Items.Contains(requested)) toolModeBox.SelectedItem = requested;
            else toolModeBox.SelectedIndex = 0;
        }

        private void UpdateToolModeDescription()
        {
            if (detectedVersion == null) return;
            var mode = Convert.ToString(toolModeBox.SelectedItem);
            statusLabel.Text = detectedVersion.Family == DevSpaceConfigFamily.Modern11
                ? "1.1.x 使用持久 config.jsonc；Tool mode 当前为 " + mode + "。"
                : "1.0.x 使用 legacy config + env；Tool mode 当前为 " + mode + "。";
        }

        private string ResolveCliPath()
        {
            if (string.IsNullOrWhiteSpace(detectedPackageRoot)) throw new InvalidOperationException("尚未检测 DevSpace package root。");
            var cli = Path.Combine(detectedPackageRoot, "dist", "cli.js");
            if (!File.Exists(cli))
            {
                throw new FileNotFoundException(
                    "当前 package root 没有已构建的 dist\\cli.js。upstream 源码仅用于参考；后续 runtime 阶段会安装独立的 packaged DevSpace。",
                    cli);
            }
            return cli;
        }

        private static string ResolveNodePath()
        {
            var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            var candidate = Path.Combine(programFiles, "nodejs", "node.exe");
            if (File.Exists(candidate)) return candidate;
            var path = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
            foreach (var directory in path.Split(Path.PathSeparator))
            {
                if (string.IsNullOrWhiteSpace(directory)) continue;
                candidate = Path.Combine(directory.Trim(), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            throw new FileNotFoundException("未找到独立 Node.js runtime。", "node.exe");
        }

        private void RefreshHistory()
        {
            historyList.Items.Clear();
            foreach (var path in history.ListNewestFirst()) historyList.Items.Add(path);
            historyPreviewBox.Clear();
        }

        private void PreviewSelectedHistory()
        {
            try
            {
                var path = Convert.ToString(historyList.SelectedItem);
                if (string.IsNullOrWhiteSpace(path)) return;
                var snapshot = history.Load(path);
                historyPreviewBox.Text =
                    "Created UTC: " + snapshot.CreatedUtc + "\r\n" +
                    "DevSpace: " + snapshot.DevSpaceVersion + "\r\n\r\n" +
                    snapshot.SettingsText;
            }
            catch (Exception exception)
            {
                historyPreviewBox.Text = "无法读取历史：" + exception.Message;
            }
        }

        private void LoadSelectedHistoryIntoForm()
        {
            try
            {
                var path = Convert.ToString(historyList.SelectedItem);
                if (string.IsNullOrWhiteSpace(path)) return;
                var snapshot = history.Load(path);
                var restored = PlatformSettingsStore.Deserialize(snapshot.SettingsText);
                settings = restored;
                PopulateForm(restored);
                ConfigureToolModes();
                if (toolModeBox.Items.Contains(restored.ToolMode)) toolModeBox.SelectedItem = restored.ToolMode;
                statusLabel.Text = "历史配置已载入表单，尚未保存/应用。";
            }
            catch (Exception exception)
            {
                MessageBox.Show(exception.Message, "载入历史失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void AddAllowedRoot()
        {
            using (var dialog = new FolderBrowserDialog())
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                var path = Path.GetFullPath(dialog.SelectedPath);
                foreach (var item in rootsList.Items)
                {
                    if (string.Equals(Convert.ToString(item), path, StringComparison.OrdinalIgnoreCase)) return;
                }
                rootsList.Items.Add(path);
            }
        }

        private void ImportLegacyQuickConfig()
        {
            try
            {
                var defaultPath = FindSiblingLegacySettingsPath();
                using (var dialog = new OpenFileDialog())
                {
                    dialog.Title = "选择旧 DevSpaceQuickTunnelTray settings.json";
                    dialog.Filter = "settings.json|settings.json|JSON files (*.json)|*.json|All files (*.*)|*.*";
                    dialog.CheckFileExists = true;
                    if (!string.IsNullOrWhiteSpace(defaultPath) && File.Exists(defaultPath))
                    {
                        dialog.FileName = defaultPath;
                        dialog.InitialDirectory = Path.GetDirectoryName(defaultPath);
                    }
                    if (dialog.ShowDialog(this) != DialogResult.OK) return;

                    var imported = LegacyQuickConfigImporter.Import(
                        dialog.FileName,
                        platformRoot,
                        detectedVersion);
                    if (File.Exists(settingsPath)) history.Snapshot(settingsPath, detectedVersion);
                    PlatformSettingsStore.Save(settingsPath, imported.Settings);
                    settings = imported.Settings;
                    PopulateForm(settings);
                    ConfigureToolModes();
                    if (toolModeBox.Items.Contains(settings.ToolMode)) toolModeBox.SelectedItem = settings.ToolMode;
                    RefreshHistory();
                    diagnosticsBox.Text = "旧配置迁移完成。\r\n\r\n" + string.Join("\r\n", imported.Notes.ToArray()) +
                        "\r\n\r\n尚未启动或重启任何 DevSpace / Cloudflare 进程。";
                    statusLabel.Text = "旧 QuickConfig 配置已迁移到新平台 settings.json。";
                }
            }
            catch (Exception exception)
            {
                MessageBox.Show(exception.Message, "旧配置迁移失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                statusLabel.Text = "旧配置未迁移。";
            }
        }

        private string FindSiblingLegacySettingsPath()
        {
            var current = new DirectoryInfo(platformRoot);
            if (string.Equals(current.Name, "bin", StringComparison.OrdinalIgnoreCase) && current.Parent != null)
            {
                current = current.Parent;
            }
            var workspace = current.Parent;
            if (workspace == null) return null;
            return Path.Combine(workspace.FullName, "DevSpaceQuickTunnelTray", "settings.json");
        }

        private void BrowsePackageRoot()
        {
            using (var dialog = new FolderBrowserDialog())
            {
                dialog.SelectedPath = packageRootBox.Text;
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                packageRootBox.Text = dialog.SelectedPath;
                DetectVersion(true);
            }
        }

        private void BrowseFile(TextBox target, string filter)
        {
            using (var dialog = new OpenFileDialog())
            {
                dialog.Filter = filter;
                dialog.CheckFileExists = true;
                if (File.Exists(target.Text)) dialog.FileName = target.Text;
                if (dialog.ShowDialog(this) == DialogResult.OK) target.Text = dialog.FileName;
            }
        }

        private void UpdateTunnelControls()
        {
            var mode = Convert.ToString(tunnelModeBox.SelectedItem);
            var remote = string.Equals(mode, "Remote", StringComparison.OrdinalIgnoreCase);
            hostnameBox.Enabled = remote;
            cloudflareTokenBox.Enabled = remote;
        }

        private void SaveCloudflareToken()
        {
            try
            {
                CloudflareTunnelSecretStore.SaveToken(platformRoot, cloudflareTokenBox.Text);
                cloudflareTokenBox.Clear();
                RefreshCloudflareTokenStatus();
                statusLabel.Text = "Cloudflare Tunnel Token 已保存到受保护的本地 secrets 文件。";
            }
            catch (Exception exception)
            {
                MessageBox.Show(exception.Message, "无法保存 Cloudflare Token", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void RefreshCloudflareTokenStatus()
        {
            var path = CloudflareTunnelSecretStore.TokenPath(platformRoot);
            cloudflareTokenStatusLabel.Text = CloudflareTunnelSecretStore.HasToken(platformRoot)
                ? "Token 状态：已配置。实际文件：" + path + "（界面不回显内容）"
                : "Token 状态：未配置。请把 Cloudflare Dashboard 提供的 Tunnel Token 粘贴到上方输入框并点击“保存 Token”。";
        }

        private static void ValidateTunnelSettings(PlatformSettings value)
        {
            if (value.AllowedRoots == null || value.AllowedRoots.Count == 0)
            {
                throw new InvalidDataException("至少需要一个 Allowed Root。");
            }
            if (string.Equals(value.TunnelMode, "Named", StringComparison.OrdinalIgnoreCase))
            {
                if (string.IsNullOrWhiteSpace(value.FixedHostname)) throw new InvalidDataException("Named Tunnel 需要 hostname。");
                if (string.IsNullOrWhiteSpace(value.NamedTunnelIdOrName)) throw new InvalidDataException("Named Tunnel 需要 UUID / 名称。");
                if (string.IsNullOrWhiteSpace(value.CredentialsFilePath) || !File.Exists(value.CredentialsFilePath))
                    throw new InvalidDataException("Named Tunnel credentials-file 不存在。");
                if (string.IsNullOrWhiteSpace(value.CloudflaredConfigPath) || !File.Exists(value.CloudflaredConfigPath))
                    throw new InvalidDataException("Named Tunnel cloudflared config 不存在。");
            }
            if (string.Equals(value.TunnelMode, "Remote", StringComparison.OrdinalIgnoreCase) &&
                string.IsNullOrWhiteSpace(value.FixedHostname))
            {
                throw new InvalidDataException("Remote Tunnel 需要 hostname。");
            }
        }

        private static string PublicBaseUrlFor(PlatformSettings value)
        {
            if ((string.Equals(value.TunnelMode, "Named", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(value.TunnelMode, "Remote", StringComparison.OrdinalIgnoreCase)) &&
                !string.IsNullOrWhiteSpace(value.FixedHostname))
            {
                return "https://" + value.FixedHostname.Trim();
            }
            return null;
        }

        private void OpenDirectory(string path)
        {
            Directory.CreateDirectory(path);
            Process.Start("explorer.exe", "\"" + path + "\"");
        }

        private static TabPage NewPage(string title)
        {
            return new TabPage(title)
            {
                AutoScroll = true,
                AutoScrollMinSize = new Size(936, 660),
                Padding = new Padding(0)
            };
        }

        private static Label AddLabel(Control parent, string text, int top, int left, int width)
        {
            var label = new Label { Text = text, Location = new Point(left, top), Size = new Size(width, 22) };
            parent.Controls.Add(label);
            return label;
        }

        private static void AddLabeledText(Control parent, string text, TextBox box, int labelTop)
        {
            AddLabel(parent, text, labelTop, 18, 500);
            parent.Controls.Add(box);
        }

        private static Button AddButton(Control parent, string text, int left, int top, int width)
        {
            var button = new Button { Text = text, Location = new Point(left, top), Size = new Size(width, 30) };
            parent.Controls.Add(button);
            return button;
        }
    }
}
