using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Reflection;
using System.Windows.Forms;

namespace DevSpaceControlPlatform
{
    internal static class AppVisuals
    {
        public static readonly Color Canvas = Color.FromArgb(245, 245, 247);
        public static readonly Color Surface = Color.White;
        public static readonly Color SurfaceMuted = Color.FromArgb(248, 248, 250);
        public static readonly Color Border = Color.FromArgb(226, 226, 230);
        public static readonly Color Primary = Color.FromArgb(0, 113, 227);
        public static readonly Color PrimaryHover = Color.FromArgb(0, 101, 204);
        public static readonly Color PrimarySoft = Color.FromArgb(232, 241, 255);
        public static readonly Color TextPrimary = Color.FromArgb(29, 29, 31);
        public static readonly Color TextSecondary = Color.FromArgb(110, 110, 115);
        public static readonly Color Success = Color.FromArgb(52, 199, 89);
        public static readonly Color Warning = Color.FromArgb(255, 149, 0);
        public static readonly Color Danger = Color.FromArgb(255, 59, 48);

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

        public static void ApplyFormTheme(Form form)
        {
            form.BackColor = Canvas;
            form.ForeColor = TextPrimary;
        }

        public static void ApplyControlTheme(Control root)
        {
            foreach (Control control in root.Controls)
            {
                var button = control as Button;
                if (button != null)
                {
                    StyleSecondaryButton(button);
                }
                else if (control is GroupBox)
                {
                    ((GroupBox)control).FlatStyle = FlatStyle.Flat;
                    control.BackColor = Surface;
                    control.ForeColor = TextSecondary;
                }
                else if (control is TabPage)
                {
                    control.BackColor = Canvas;
                    control.ForeColor = TextPrimary;
                }
                else if (control is DataGridView)
                {
                    var grid = (DataGridView)control;
                    grid.BackgroundColor = Surface;
                    grid.BorderStyle = BorderStyle.None;
                    grid.GridColor = Color.FromArgb(238, 238, 240);
                    grid.EnableHeadersVisualStyles = false;
                    grid.ColumnHeadersBorderStyle = DataGridViewHeaderBorderStyle.None;
                    grid.CellBorderStyle = DataGridViewCellBorderStyle.SingleHorizontal;
                    grid.ColumnHeadersDefaultCellStyle.BackColor = Surface;
                    grid.ColumnHeadersDefaultCellStyle.ForeColor = TextPrimary;
                    grid.DefaultCellStyle.BackColor = Surface;
                    grid.DefaultCellStyle.ForeColor = TextPrimary;
                    grid.DefaultCellStyle.SelectionBackColor = PrimarySoft;
                    grid.DefaultCellStyle.SelectionForeColor = TextPrimary;
                    RoundControl(grid, 10);
                }
                else if (control is TextBoxBase)
                {
                    StyleTextBox((TextBoxBase)control);
                }
                else if (control is ListBox)
                {
                    var list = (ListBox)control;
                    list.BorderStyle = BorderStyle.None;
                    list.BackColor = SurfaceMuted;
                    list.ForeColor = TextPrimary;
                    RoundControl(list, 8);
                }
                else if (control is ComboBox)
                {
                    var combo = (ComboBox)control;
                    combo.FlatStyle = FlatStyle.Flat;
                    combo.BackColor = SurfaceMuted;
                    combo.ForeColor = TextPrimary;
                    RoundControl(combo, 8);
                }
                else if (control is NumericUpDown)
                {
                    var numeric = (NumericUpDown)control;
                    numeric.BorderStyle = BorderStyle.None;
                    numeric.BackColor = SurfaceMuted;
                    numeric.ForeColor = TextPrimary;
                    RoundControl(numeric, 8);
                }
                else if (control is CheckBox)
                {
                    var check = (CheckBox)control;
                    check.FlatStyle = FlatStyle.Flat;
                    check.ForeColor = TextPrimary;
                }
                else if (control is Label)
                {
                    control.ForeColor = control.ForeColor == Color.DarkRed
                        ? Danger
                        : control.ForeColor == Color.DarkGreen
                            ? Success
                            : control.ForeColor == Color.DimGray
                                ? TextSecondary
                                : control.ForeColor;
                }

                if (control.HasChildren) ApplyControlTheme(control);
            }
        }

        public static void StylePrimaryButton(Button button)
        {
            button.FlatStyle = FlatStyle.Flat;
            button.FlatAppearance.BorderSize = 0;
            button.BackColor = Primary;
            button.ForeColor = Color.White;
            button.FlatAppearance.MouseOverBackColor = PrimaryHover;
            button.FlatAppearance.MouseDownBackColor = Color.FromArgb(0, 88, 180);
            button.UseVisualStyleBackColor = false;
            button.Cursor = Cursors.Hand;
            button.Font = new Font(button.Font, FontStyle.Bold);
            RoundControl(button, 9);
        }

        public static void StyleSecondaryButton(Button button)
        {
            button.FlatStyle = FlatStyle.Flat;
            button.FlatAppearance.BorderSize = 0;
            button.BackColor = SurfaceMuted;
            button.ForeColor = TextPrimary;
            button.FlatAppearance.MouseOverBackColor = Color.FromArgb(238, 238, 241);
            button.FlatAppearance.MouseDownBackColor = Color.FromArgb(228, 228, 232);
            button.UseVisualStyleBackColor = false;
            button.Cursor = Cursors.Hand;
            RoundControl(button, 9);
        }

        public static void StyleCard(Panel panel)
        {
            panel.BackColor = Surface;
            RoundControl(panel, 16);
        }

        public static void RoundControl(Control control, int radius)
        {
            ApplyRoundedRegion(control, radius);
            control.Resize += delegate { ApplyRoundedRegion(control, radius); };
        }

        public static void FillRoundedRectangle(Graphics graphics, Brush brush, Rectangle bounds, int radius)
        {
            using (var path = CreateRoundedPath(bounds, radius))
                graphics.FillPath(brush, path);
        }

        private static void StyleTextBox(TextBoxBase box)
        {
            box.BorderStyle = BorderStyle.None;
            box.BackColor = SurfaceMuted;
            box.ForeColor = TextPrimary;
            var textBox = box as TextBox;
            if (textBox != null && !textBox.Multiline)
            {
                textBox.AutoSize = false;
                if (textBox.Height < 28) textBox.Height = 28;
            }
            RoundControl(box, 7);
        }

        private static void ApplyRoundedRegion(Control control, int radius)
        {
            if (control.Width <= 1 || control.Height <= 1) return;
            using (var path = CreateRoundedPath(new Rectangle(0, 0, control.Width, control.Height), radius))
            {
                var old = control.Region;
                control.Region = new Region(path);
                if (old != null) old.Dispose();
            }
        }

        private static GraphicsPath CreateRoundedPath(Rectangle bounds, int radius)
        {
            var path = new GraphicsPath();
            var diameter = Math.Max(2, Math.Min(radius * 2, Math.Min(bounds.Width, bounds.Height)));
            var arc = new Rectangle(bounds.X, bounds.Y, diameter, diameter);
            path.AddArc(arc, 180, 90);
            arc.X = bounds.Right - diameter;
            path.AddArc(arc, 270, 90);
            arc.Y = bounds.Bottom - diameter;
            path.AddArc(arc, 0, 90);
            arc.X = bounds.Left;
            path.AddArc(arc, 90, 90);
            path.CloseFigure();
            return path;
        }
    }
}
