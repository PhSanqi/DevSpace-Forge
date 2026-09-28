using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using DevSpaceControlPlatform;

internal static class VisualLayoutSnapshot
{
    [STAThread]
    private static int Main(string[] args)
    {
        try { return Run(args); }
        catch (Exception exception)
        {
            Console.Error.WriteLine("FAIL " + exception.GetType().FullName + ": " + exception.Message);
            Console.Error.WriteLine(exception.StackTrace ?? string.Empty);
            return 1;
        }
    }

    private static int Run(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        VerifyHttpHealthProbe();
        var output = Path.GetFullPath(args.Length == 0 ? "ui-snapshots" : args[0]);
        Directory.CreateDirectory(output);

        using (var supervisor = new ServiceSupervisor(AppDomain.CurrentDomain.BaseDirectory))
        using (var form = new MainForm(supervisor))
        {
            form.ShowInTaskbar = false;
            form.StartPosition = FormStartPosition.Manual;
            form.Location = new Point(-30000, -30000);
            form.Show();
            Application.DoEvents();

            var tabs = Descendants(form).OfType<TabControl>().Single();
            var baseline = CaptureLayout(form, tabs, output, new Size(1000, 760), "1000x760");
            var expanded = CaptureLayout(form, tabs, output, new Size(1400, 900), "1400x900");
            var screenshotSize = CaptureLayout(form, tabs, output, new Size(1612, 1000), "1612x1000");
            var restored = CaptureLayout(form, tabs, output, new Size(1000, 760), "1000x760-restored");

            var failures = new List<string>();
            foreach (var page in baseline.Keys)
            {
                foreach (var item in baseline[page])
                {
                    Rectangle next;
                    if (!expanded[page].TryGetValue(item.Key, out next))
                        failures.Add(page + ": expanded layout is missing " + item.Key);
                    else if (item.Value != next)
                        failures.Add(page + ": control moved/resized: " + item.Key + " " + item.Value + " -> " + next);

                    Rectangle atScreenshotSize;
                    if (!screenshotSize[page].TryGetValue(item.Key, out atScreenshotSize))
                        failures.Add(page + ": screenshot-size layout is missing " + item.Key);
                    else if (item.Value != atScreenshotSize)
                        failures.Add(page + ": control moved/resized at screenshot size: " + item.Key + " " + item.Value + " -> " + atScreenshotSize);

                    Rectangle afterRestore;
                    if (!restored[page].TryGetValue(item.Key, out afterRestore))
                        failures.Add(page + ": restored layout is missing " + item.Key);
                    else if (item.Value != afterRestore)
                        failures.Add(page + ": control did not restore after resize: " + item.Key + " " + item.Value + " -> " + afterRestore);
                }
            }

            foreach (TabPage page in tabs.TabPages)
            {
                foreach (Control control in page.Controls)
                {
                    if (control.Right > 936)
                        failures.Add(page.Text + ": control exceeds fixed page boundary: " + Describe(control));
                }
            }

            form.Close();
            if (failures.Count == 0)
            {
                Console.WriteLine("PASS visual layout is fixed across resize-expand-restore and remains inside the 936px page boundary.");
                return 0;
            }
            foreach (var failure in failures) Console.Error.WriteLine("FAIL " + failure);
            return 1;
        }
    }

    private static void VerifyHttpHealthProbe()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        string requestText = null;
        var server = new Thread(delegate()
        {
            try
            {
                using (var client = listener.AcceptTcpClient())
                using (var stream = client.GetStream())
                {
                    stream.ReadTimeout = 2000;
                    var buffer = new byte[4096];
                    var count = stream.Read(buffer, 0, buffer.Length);
                    requestText = Encoding.ASCII.GetString(buffer, 0, count);
                    var response = Encoding.ASCII.GetBytes("HTTP/1.0 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    stream.Write(response, 0, response.Length);
                }
            }
            finally { listener.Stop(); }
        });
        server.IsBackground = true;
        server.Start();

        if (!ServiceSupervisor.ProbeLocalHttp(port, 1500))
            throw new InvalidOperationException("HTTP health probe rejected a responding origin.");
        server.Join(2500);
        if (string.IsNullOrWhiteSpace(requestText) || !requestText.StartsWith("GET / HTTP/1.0", StringComparison.Ordinal))
            throw new InvalidOperationException("Health probe did not send a complete HTTP request.");
    }

    private static Dictionary<string, Dictionary<string, Rectangle>> CaptureLayout(
        Form form,
        TabControl tabs,
        string output,
        Size clientSize,
        string suffix)
    {
        form.ClientSize = clientSize;
        Application.DoEvents();
        var result = new Dictionary<string, Dictionary<string, Rectangle>>();
        foreach (TabPage page in tabs.TabPages)
        {
            tabs.SelectedTab = page;
            page.AutoScrollPosition = Point.Empty;
            Application.DoEvents();
            result[page.Text] = PageLayout(page);
            using (var bitmap = new Bitmap(form.Width, form.Height))
            {
                form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, form.Size));
                bitmap.Save(Path.Combine(output, SafeName(page.Text) + "-" + suffix + ".png"), ImageFormat.Png);
            }
        }
        return result;
    }

    private static Dictionary<string, Rectangle> PageLayout(TabPage page)
    {
        var result = new Dictionary<string, Rectangle>();
        Collect(page, string.Empty, result);
        return result;
    }

    private static IEnumerable<Control> Descendants(Control parent)
    {
        foreach (Control child in parent.Controls)
        {
            yield return child;
            foreach (var descendant in Descendants(child)) yield return descendant;
        }
    }

    private static void Collect(Control parent, string path, Dictionary<string, Rectangle> result)
    {
        for (var index = 0; index < parent.Controls.Count; index++)
        {
            var control = parent.Controls[index];
            var key = path + "/" + index + ":" + Describe(control);
            result[key] = control.Bounds;
            Collect(control, key, result);
        }
    }

    private static string Describe(Control control)
    {
        var text = (control.Text ?? string.Empty).Replace("\r", " ").Replace("\n", " ");
        if (text.Length > 24) text = text.Substring(0, 24);
        return control.GetType().Name + "[" + text + "]";
    }

    private static string SafeName(string value)
    {
        foreach (var character in Path.GetInvalidFileNameChars()) value = value.Replace(character, '_');
        return value;
    }
}
