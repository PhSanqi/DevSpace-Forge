using System.Drawing;
using System.Reflection;

namespace DevSpaceControlPlatform
{
    internal static class AppVisuals
    {
        public static Icon CreateApplicationIcon()
        {
            try
            {
                var assembly = Assembly.GetExecutingAssembly();
                using (var stream = assembly.GetManifestResourceStream("DevSpaceControlPlatform.Icon"))
                {
                    if (stream != null)
                    {
                        using (var icon = new Icon(stream, new Size(32, 32)))
                            return (Icon)icon.Clone();
                    }
                }
            }
            catch
            {
            }
            return (Icon)SystemIcons.Application.Clone();
        }
    }
}
