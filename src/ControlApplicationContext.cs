using System;
using System.Windows.Forms;

namespace DevSpaceControlPlatform
{
    internal sealed class ControlApplicationContext : ApplicationContext
    {
        private readonly ServiceSupervisor supervisor;
        private readonly MainForm mainForm;
        private readonly NotifyIcon trayIcon;
        private readonly Timer statusTimer;
        private bool exiting;

        public ControlApplicationContext()
        {
            var root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(System.IO.Path.DirectorySeparatorChar);
            supervisor = new ServiceSupervisor(root);
            mainForm = new MainForm(supervisor);

            var menu = new ContextMenuStrip();
            menu.Items.Add("打开控制面板", null, delegate { ShowMainForm(); });
            menu.Items.Add("复制 MCP 地址", null, delegate { CopyMcpUrl(); });
            menu.Items.Add("复制 Owner password", null, delegate { CopyOwnerPassword(); });
            menu.Items.Add(new ToolStripSeparator());

            var devSpaceMenu = new ToolStripMenuItem("DevSpace");
            devSpaceMenu.DropDownItems.Add("启动", null, delegate { RunAction(supervisor.StartDevSpace); });
            devSpaceMenu.DropDownItems.Add("停止", null, delegate { RunAction(supervisor.StopDevSpace); });
            devSpaceMenu.DropDownItems.Add("重新启动", null, delegate { RunAction(supervisor.RestartDevSpace); });
            menu.Items.Add(devSpaceMenu);

            var cloudflareMenu = new ToolStripMenuItem("Cloudflare Tunnel");
            cloudflareMenu.DropDownItems.Add("启动", null, delegate { RunAction(supervisor.StartCloudflare); });
            cloudflareMenu.DropDownItems.Add("停止", null, delegate { RunAction(supervisor.StopCloudflare); });
            cloudflareMenu.DropDownItems.Add("重新启动", null, delegate { RunAction(supervisor.RestartCloudflare); });
            menu.Items.Add(cloudflareMenu);

            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("启动全部", null, delegate { RunAction(supervisor.StartAll); });
            menu.Items.Add("停止全部", null, delegate { RunAction(supervisor.StopAll); });
            menu.Items.Add("重新启动全部", null, delegate { RunAction(supervisor.RestartAll); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出并停止服务", null, delegate { ExitApplication(); });

            trayIcon = new NotifyIcon
            {
                Icon = AppVisuals.CreateApplicationIcon(),
                Text = "DevSpace Control Platform",
                ContextMenuStrip = menu,
                Visible = true
            };
            trayIcon.DoubleClick += delegate { ShowMainForm(); };

            statusTimer = new Timer { Interval = 1000 };
            statusTimer.Tick += delegate
            {
                mainForm.RefreshServiceStatus();
                var dev = supervisor.IsDevSpaceRunning ? "DevSpace:ON" : "DevSpace:OFF";
                var cf = supervisor.IsCloudflareRunning ? "CF:ON" : "CF:OFF";
                trayIcon.Text = Truncate("DevSpace Control Platform - " + dev + " " + cf, 63);
            };
            statusTimer.Start();

            try { supervisor.ApplyWindowsAutoStartFromSettings(); }
            catch { }
            RunAction(supervisor.StartAll, false);
            ShowMainForm();
        }

        private void ShowMainForm()
        {
            if (!mainForm.Visible) mainForm.Show();
            if (mainForm.WindowState == FormWindowState.Minimized) mainForm.WindowState = FormWindowState.Normal;
            mainForm.Activate();
            mainForm.RefreshServiceStatus();
        }

        private void RunAction(Action action)
        {
            RunAction(action, true);
        }

        private void RunAction(Action action, bool showError)
        {
            try
            {
                action();
                mainForm.RefreshServiceStatus();
            }
            catch (Exception exception)
            {
                if (showError)
                    MessageBox.Show(exception.Message, "服务操作失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void CopyMcpUrl()
        {
            var value = supervisor.McpUrl;
            if (string.IsNullOrWhiteSpace(value))
            {
                MessageBox.Show("MCP 地址尚未生成。", "DevSpace Control Platform", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            Clipboard.SetText(value);
            trayIcon.ShowBalloonTip(1500, "已复制 MCP 地址", value, ToolTipIcon.Info);
        }

        private void CopyOwnerPassword()
        {
            var value = supervisor.OwnerPassword;
            if (string.IsNullOrWhiteSpace(value))
            {
                MessageBox.Show("Owner password 尚未生成。", "DevSpace Control Platform", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            Clipboard.SetText(value);
            trayIcon.ShowBalloonTip(1500, "已复制 Owner password", "Owner password 已复制到剪贴板。", ToolTipIcon.Info);
        }

        private void ExitApplication()
        {
            if (exiting) return;
            exiting = true;
            statusTimer.Stop();
            supervisor.Dispose();
            trayIcon.Visible = false;
            trayIcon.Dispose();
            mainForm.AllowApplicationClose();
            mainForm.Close();
            ExitThread();
        }

        private static string Truncate(string value, int maxLength)
        {
            return value.Length <= maxLength ? value : value.Substring(0, maxLength);
        }
    }
}
