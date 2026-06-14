// RuneType Glyphmaker — custom shaped (per-pixel alpha) installer.
// Frameless brush-art window. Installs the CEP panel to %APPDATA%\Adobe\CEP\extensions
// + PlayerDebugMode (CSXS 6..12), no admin. Assets + payload.zip embedded as resources.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace RuneTypeInstaller
{
    static class Program
    {
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [STAThread]
        static void Main()
        {
            try { SetProcessDPIAware(); } catch { }
            Application.Run(new MainForm());
        }
    }

    class MainForm : Form
    {
        const int OX = 1543, OY = 364, CANW = 937, CANH = 1351; // UI bbox in 4K canvas coords
        readonly double S;                                       // window scale (DPI/screen adaptive)
        static readonly Color RED = Color.FromArgb(192, 39, 29);
        const string EXT_ID = "com.fontmaker.illustrator";

        // menu layout (4K canvas coords) — items centered on MCX
        const double RX = 2104;   // right edge — menu is right-aligned so the dots line up
        const double Y_INSTALL = 916, Y_ACTIVATE = 1022, Y_SHOP = 1094, Y_ABOUT = 1166, Y_UNINSTALL = 1238;

        Dictionary<string, Bitmap> A = new Dictionary<string, Bitmap>();
        Dictionary<string, Rectangle> AP = new Dictionary<string, Rectangle>();
        PrivateFontCollection pfc;
        FontFamily pathFam;

        string hover = "";   // "", install, uninstall, x, folder
        int phase = 0;       // 0 idle, 1 working, 2 done
        double progress = 0;
        bool busy = false;

        [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
        [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
        [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
        [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
        [DllImport("user32.dll")] static extern bool UpdateLayeredWindow(IntPtr h, IntPtr dst, ref Point ppos, ref Size psz, IntPtr src, ref Point psrc, int key, ref BLENDFUNCTION pb, int flags);
        [DllImport("user32.dll")] static extern bool ReleaseCapture();
        [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr wp, IntPtr lp);
        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        struct BLENDFUNCTION { public byte Op, Flags, Alpha, Format; }
        const int WS_EX_LAYERED = 0x80000, WM_NCLBUTTONDOWN = 0xA1, HTCAPTION = 0x2;
        const byte AC_SRC_OVER = 0x00, AC_SRC_ALPHA = 0x01;
        const int ULW_ALPHA = 0x02;

        public MainForm()
        {
            int sh = Screen.PrimaryScreen.WorkingArea.Height;
            S = Math.Min(1.0, Math.Max(0.6, sh * 0.62 / CANH));

            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = true;
            StartPosition = FormStartPosition.CenterScreen;
            Text = "RuneType Glyphmaker Setup";
            TopMost = true;
            try { Icon = new Icon(GetType().Assembly.GetManifestResourceStream("setup.ico")); } catch { }
            ClientSize = new Size((int)Math.Round(CANW * S), (int)Math.Round(CANH * S));

            LoadAssets();
            LoadFont();
            BuildPathText();
            MouseMove += OnMove;
            MouseDown += OnDown;
            MouseLeave += delegate { if (hover != "") { hover = ""; Render(); } };
        }

        protected override CreateParams CreateParams
        {
            get { CreateParams p = base.CreateParams; p.ExStyle |= WS_EX_LAYERED; return p; }
        }

        protected override void OnShown(EventArgs e) { base.OnShown(e); Render(); }

        void Place(string k, int l, int t, int w, int h) { AP[k] = new Rectangle(l, t, w, h); }

        Bitmap Res(string name)
        {
            using (Stream s = GetType().Assembly.GetManifestResourceStream(name))
            using (Bitmap tmp = new Bitmap(s))
                return new Bitmap(tmp);
        }

        void LoadAssets()
        {
            Place("mainbg", 1583, 693, 707, 1022);
            Place("install-bg", 1889, 858, 231, 117);
            Place("layelogor_1", 1543, 364, 753, 628);
            Place("brst_logo", 1855, 1430, 180, 53);
            Place("bar", 1729, 1320, 400, 64);
            Place("folder", 2051, 1330, 55, 35);
            Place("x", 2254, 451, 84, 96);
            Place("exit", 2273, 469, 207, 58);
            Place("done", 1808, 1280, 243, 150);
            Place("loading", 1757, 1342, 323, 20);
            string[] files = { "mainbg","install-bg","layelogor_1","brst_logo","bar","folder",
                "x","exit","done","loading",
                "install_black","install_red","activate","shop_dim","about","uninstall","uninstall_red" };
            foreach (string f in files) { try { A[f] = Res(f + ".png"); } catch { } }
        }

        void LoadFont()
        {
            try
            {
                byte[] b;
                using (Stream s = GetType().Assembly.GetManifestResourceStream("delight.otf"))
                using (MemoryStream ms = new MemoryStream()) { s.CopyTo(ms); b = ms.ToArray(); }
                IntPtr p = Marshal.AllocCoTaskMem(b.Length);
                Marshal.Copy(b, 0, p, b.Length);
                pfc = new PrivateFontCollection();
                pfc.AddMemoryFont(p, b.Length);
                pathFam = pfc.Families[0];
            }
            catch { pathFam = FontFamily.GenericSansSerif; }
        }

        // render the real install path into the bar field (dark text on the white field), truncated to fit
        void BuildPathText()
        {
            string s = Target();
            Color col = Color.FromArgb(49, 44, 44);
            int Wmax = 286;
            using (Font f = new Font(pathFam, 22f, FontStyle.Regular, GraphicsUnit.Pixel))
            using (Bitmap probe = new Bitmap(1, 1))
            using (Graphics pg = Graphics.FromImage(probe))
            {
                pg.TextRenderingHint = TextRenderingHint.AntiAlias;
                if (pg.MeasureString(s, f).Width > Wmax)
                {
                    while (s.Length > 6 && pg.MeasureString(s + "…", f).Width > Wmax) s = s.Substring(0, s.Length - 1);
                    s = s + "…";
                }
                SizeF sz = pg.MeasureString(s, f);
                int w = (int)Math.Ceiling(sz.Width) + 2, h = (int)Math.Ceiling(sz.Height) + 2;
                Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.Clear(Color.Transparent);
                    g.TextRenderingHint = TextRenderingHint.AntiAlias;
                    using (SolidBrush br = new SolidBrush(col)) g.DrawString(s, f, br, 1, 1);
                }
                A["pathtext"] = bmp;
                Place("pathtext", 1758, 1352 - h / 2, w, h);
            }
        }

        // draw an absolutely-placed asset (AP)
        void Draw(Graphics g, string k)
        {
            if (!A.ContainsKey(k) || !AP.ContainsKey(k)) return;
            Rectangle r = AP[k];
            g.DrawImage(A[k], new RectangleF((float)((r.X - OX) * S), (float)((r.Y - OY) * S), (float)(r.Width * S), (float)(r.Height * S)),
                        new RectangleF(0, 0, A[k].Width, A[k].Height), GraphicsUnit.Pixel);
        }

        // draw a menu asset right-aligned: right edge at canvas x=rx, vertically centered at ccy
        void DrawR(Graphics g, string k, double rx, double ccy)
        {
            if (!A.ContainsKey(k)) return;
            Bitmap b = A[k];
            double L = rx - b.Width, T = ccy - b.Height / 2.0;
            g.DrawImage(b, new RectangleF((float)((L - OX) * S), (float)((T - OY) * S), (float)(b.Width * S), (float)(b.Height * S)),
                        new RectangleF(0, 0, b.Width, b.Height), GraphicsUnit.Pixel);
        }

        // progress = the brushy red "loading" stroke, revealed left-to-right
        void DrawProgress(Graphics g)
        {
            if (!A.ContainsKey("loading") || !AP.ContainsKey("loading")) return;
            Bitmap b = A["loading"]; Rectangle r = AP["loading"];
            double frac = Math.Max(0.03, Math.Min(1, progress));
            RectangleF dst = new RectangleF((float)((r.X - OX) * S), (float)((r.Y - OY) * S), (float)(r.Width * frac * S), (float)(r.Height * S));
            g.DrawImage(b, dst, new RectangleF(0, 0, (float)(b.Width * frac), b.Height), GraphicsUnit.Pixel);
        }

        void Render()
        {
            int W = (int)Math.Round(CANW * S), H = (int)Math.Round(CANH * S);
            Bitmap bmp = new Bitmap(W, H, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.Transparent);
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.CompositingQuality = CompositingQuality.HighQuality;

                Draw(g, "mainbg");
                Draw(g, "layelogor_1");
                Draw(g, "brst_logo");

                // menu drawn on top of the wordmark so the logo never covers install
                Draw(g, "install-bg");      // filled white brush box (install is the primary CTA)
                bool idle = phase == 0;
                DrawR(g, idle && hover == "install" ? "install_red" : "install_black", RX, Y_INSTALL);
                DrawR(g, "activate", RX, Y_ACTIVATE);    // disabled (dim)
                DrawR(g, "shop_dim", RX, Y_SHOP);        // disabled (dim)
                DrawR(g, "about", RX, Y_ABOUT);          // disabled (dim)
                DrawR(g, idle && hover == "uninstall" ? "uninstall_red" : "uninstall", RX, Y_UNINSTALL);

                Draw(g, "bar");
                if (phase == 0) { Draw(g, "pathtext"); Draw(g, "folder"); }
                else if (phase == 1) { DrawProgress(g); }
                else if (phase == 2) { Draw(g, "done"); }

                Draw(g, "x");
                if (hover == "x") Draw(g, "exit");
            }
            Premultiply(bmp);
            SetBitmap(bmp);
            bmp.Dispose();
        }

        static void Premultiply(Bitmap bmp)
        {
            Rectangle r = new Rectangle(0, 0, bmp.Width, bmp.Height);
            BitmapData d = bmp.LockBits(r, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
            int n = d.Stride * d.Height;
            byte[] buf = new byte[n];
            Marshal.Copy(d.Scan0, buf, 0, n);
            for (int i = 0; i < n; i += 4)
            {
                byte a = buf[i + 3];
                if (a == 255) continue;
                buf[i] = (byte)(buf[i] * a / 255);
                buf[i + 1] = (byte)(buf[i + 1] * a / 255);
                buf[i + 2] = (byte)(buf[i + 2] * a / 255);
            }
            Marshal.Copy(buf, 0, d.Scan0, n);
            bmp.UnlockBits(d);
        }

        void SetBitmap(Bitmap bmp)
        {
            IntPtr screen = GetDC(IntPtr.Zero);
            IntPtr mem = CreateCompatibleDC(screen);
            IntPtr hbm = IntPtr.Zero, old = IntPtr.Zero;
            try
            {
                hbm = bmp.GetHbitmap(Color.FromArgb(0));
                old = SelectObject(mem, hbm);
                Size sz = new Size(bmp.Width, bmp.Height);
                Point src = new Point(0, 0);
                Point pos = new Point(Left, Top);
                BLENDFUNCTION bf = new BLENDFUNCTION();
                bf.Op = AC_SRC_OVER; bf.Flags = 0; bf.Alpha = 255; bf.Format = AC_SRC_ALPHA;
                UpdateLayeredWindow(Handle, screen, ref pos, ref sz, mem, ref src, 0, ref bf, ULW_ALPHA);
            }
            finally
            {
                ReleaseDC(IntPtr.Zero, screen);
                if (hbm != IntPtr.Zero) { SelectObject(mem, old); DeleteObject(hbm); }
                DeleteDC(mem);
            }
        }

        Rectangle RectC(double cx, double cy, int w, int h, int px, int py)
        {
            return new Rectangle((int)(cx - w / 2.0) - px, (int)(cy - h / 2.0) - py, w + 2 * px, h + 2 * py);
        }
        static Rectangle Pad(Rectangle r, int px, int py) { return new Rectangle(r.X - px, r.Y - py, r.Width + 2 * px, r.Height + 2 * py); }

        string HitTest(int mx, int my)
        {
            int cx = (int)(mx / S + OX), cy = (int)(my / S + OY);
            if (Pad(AP["x"], 16, 14).Contains(cx, cy)) return "x";
            if (phase == 0)
            {
                if (Pad(AP["install-bg"], 6, 6).Contains(cx, cy)) return "install";
                int uw = A.ContainsKey("uninstall") ? A["uninstall"].Width : 182;
                if (new Rectangle((int)(RX - uw) - 18, (int)Y_UNINSTALL - 28, uw + 36, 56).Contains(cx, cy)) return "uninstall";
                if (Pad(AP["folder"], 8, 8).Contains(cx, cy)) return "folder";
            }
            return "";
        }

        void OnMove(object s, MouseEventArgs e)
        {
            string h = HitTest(e.X, e.Y);
            if (h != hover) { hover = h; Render(); }
            Cursor = (hover == "install" || hover == "uninstall" || hover == "x" || hover == "folder") ? Cursors.Hand : Cursors.Default;
        }

        void OnDown(object s, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            string h = HitTest(e.X, e.Y);
            if (h == "x") { Close(); return; }
            if (busy) return;
            if (h == "install") { StartWork(true); return; }
            if (h == "uninstall") { StartWork(false); return; }
            if (h == "folder") { try { System.Diagnostics.Process.Start("explorer.exe", Target()); } catch { } return; }
            ReleaseCapture();
            SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
        }

        static string Target()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                @"Adobe\CEP\extensions\" + EXT_ID);
        }

        void StartWork(bool install)
        {
            busy = true; phase = 1; progress = 0; hover = ""; Render();
            Thread t = new Thread(delegate () { Work(install); });
            t.IsBackground = true; t.Start();
        }

        void Report(double p)
        {
            progress = p;
            try { BeginInvoke((MethodInvoker)delegate { Render(); }); } catch { }
        }

        void Work(bool install)
        {
            try
            {
                string target = Target();
                if (install)
                {
                    if (Directory.Exists(target)) { try { Directory.Delete(target, true); } catch { } }
                    Directory.CreateDirectory(target);
                    using (Stream zs = GetType().Assembly.GetManifestResourceStream("payload.zip"))
                    using (ZipArchive zip = new ZipArchive(zs, ZipArchiveMode.Read))
                    {
                        int total = zip.Entries.Count, i = 0;
                        foreach (ZipArchiveEntry en in zip.Entries)
                        {
                            string dest = Path.Combine(target, en.FullName.Replace('/', '\\'));
                            if (en.FullName.EndsWith("/")) Directory.CreateDirectory(dest);
                            else
                            {
                                Directory.CreateDirectory(Path.GetDirectoryName(dest));
                                using (Stream es = en.Open())
                                using (FileStream fs = File.Create(dest)) es.CopyTo(fs);
                            }
                            i++;
                            Report(0.08 + 0.84 * i / Math.Max(1, total));
                            Thread.Sleep(14);
                        }
                    }
                    for (int v = 6; v <= 12; v++)
                        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(@"Software\Adobe\CSXS." + v))
                            if (k != null) k.SetValue("PlayerDebugMode", "1", RegistryValueKind.String);
                    Report(1.0);
                }
                else
                {
                    if (Directory.Exists(target))
                    {
                        string[] all = Directory.GetFiles(target, "*", SearchOption.AllDirectories);
                        for (int i = 0; i < all.Length; i++)
                        {
                            try { File.Delete(all[i]); } catch { }
                            Report(0.05 + 0.9 * (i + 1) / Math.Max(1, all.Length));
                            Thread.Sleep(8);
                        }
                        try { Directory.Delete(target, true); } catch { }
                    }
                    Report(1.0);
                }
            }
            catch (Exception ex)
            {
                try { BeginInvoke((MethodInvoker)delegate { MessageBox.Show(ex.Message, "RuneType Setup"); }); } catch { }
            }
            try
            {
                BeginInvoke((MethodInvoker)delegate
                {
                    phase = 2; busy = false; Render();
                    System.Windows.Forms.Timer tm = new System.Windows.Forms.Timer(); tm.Interval = 2000;
                    tm.Tick += delegate { tm.Stop(); Close(); };
                    tm.Start();
                });
            }
            catch { }
        }
    }
}
