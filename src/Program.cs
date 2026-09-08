using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace DevSpaceControlPlatform
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            DeleteOldExecutableCopy("DevSpaceControlPlatform.previous.exe");
            DeleteOldExecutableCopy("DevSpaceControlPlatform.running.exe");
            DeleteOldExecutableCopy("DevSpaceControlPlatform.current.exe");
            RefreshExplorerIcon();

            bool createdNew;
            using (var mutex = new Mutex(true, @"Local\DevSpaceControlPlatform", out createdNew))
            {
                if (!createdNew)
                {
                    MessageBox.Show(
                        "DevSpace Control Platform 已经在运行，请查看任务栏托盘。",
                        "DevSpace Control Platform",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information);
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new ControlApplicationContext());
            }
        }

        private static void DeleteOldExecutableCopy(string fileName)
        {
            try
            {
                var path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, fileName);
                if (File.Exists(path)) File.Delete(path);
            }
            catch
            {
            }
        }

        private static void RefreshExplorerIcon()
        {
            try
            {
                SHChangeNotify(0x00002000, 0x0005, Application.ExecutablePath, IntPtr.Zero);
                SHChangeNotify(0x08000000, 0x0000, null, IntPtr.Zero);
            }
            catch
            {
            }
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        private static extern void SHChangeNotify(int eventId, uint flags, string item1, IntPtr item2);
    }
}
