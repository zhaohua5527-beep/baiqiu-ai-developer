using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Security.Cryptography;
using System.Threading;
using System.Windows.Forms;

internal static class InstallerEntry
{
    [STAThread]
    private static void Main()
    {
        bool created;
        using (var mutex = new Mutex(true, "Local\\BaiqiuPortableInstaller", out created)) {
            if (!created) { MessageBox.Show("安装程序已经打开，请查看已有窗口。", "白球AI安装"); return; }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new InstallerWindow());
        }
    }
}

internal sealed class InstallerWindow : Form
{
    private readonly TextBox destination = new TextBox();
    private readonly Label status = new Label();
    private readonly ProgressBar progress = new ProgressBar();
    private readonly Button install = new Button();
    private readonly Button browse = new Button();
    private bool working;

    internal InstallerWindow()
    {
        Text = "安装白球AI";
        ClientSize = new Size(640, 290);
        Font = new Font("Microsoft YaHei UI", 10);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        var title = new Label { Text = "将本硬盘上的当前白球AI安装到电脑", AutoSize = true, Left = 22, Top = 20 };
        var note = new Label { Text = "不复制个人聊天记录、记忆、密钥和登录状态。\n安装完成后生成桌面快捷方式；便携版仍可直接启动。", AutoSize = true, Left = 22, Top = 50 };
        destination.SetBounds(22, 106, 490, 30);
        destination.Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "白球AI");
        browse.Text = "选择位置";
        browse.SetBounds(522, 104, 96, 32);
        browse.Click += delegate {
            using (var dialog = new FolderBrowserDialog { Description = "选择安装位置，程序将在其中建立“白球AI”文件夹" })
                if (dialog.ShowDialog(this) == DialogResult.OK) destination.Text = Path.Combine(dialog.SelectedPath, "白球AI");
        };
        status.SetBounds(22, 150, 596, 48);
        status.Text = "准备就绪。点击安装后开始检查与复制。";
        progress.SetBounds(22, 202, 596, 16);
        install.Text = "开始安装";
        install.SetBounds(498, 236, 120, 34);
        install.Click += BeginInstall;
        Controls.AddRange(new Control[] { title, note, destination, browse, status, progress, install });
        FormClosing += delegate(object sender, FormClosingEventArgs args) {
            if (working) { args.Cancel = true; status.Text = "正在安装，请等复制和校验完成后再关闭。"; }
        };
    }

    private void BeginInstall(object sender, EventArgs args)
    {
        if (working) return;
        var target = destination.Text.Trim();
        var source = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "白球AI便携版", "app");
        working = true;
        destination.Enabled = browse.Enabled = install.Enabled = false;
        progress.Style = ProgressBarStyle.Marquee;
        var worker = new BackgroundWorker { WorkerReportsProgress = true };
        worker.ProgressChanged += delegate(object origin, ProgressChangedEventArgs update) {
            progress.Style = update.ProgressPercentage < 0 ? ProgressBarStyle.Marquee : ProgressBarStyle.Continuous;
            if (update.ProgressPercentage >= 0) progress.Value = Math.Min(100, update.ProgressPercentage);
            status.Text = Convert.ToString(update.UserState);
        };
        worker.DoWork += delegate(object origin, DoWorkEventArgs work) {
            work.Result = InstallerCore.Install(source, target, (percent, text) => worker.ReportProgress(percent, text));
        };
        worker.RunWorkerCompleted += delegate(object origin, RunWorkerCompletedEventArgs result) {
            working = false;
            destination.Enabled = browse.Enabled = install.Enabled = true;
            progress.Style = ProgressBarStyle.Continuous;
            if (result.Error != null) {
                status.Text = "安装未完成，原程序不会被不完整副本覆盖。";
                MessageBox.Show(this, result.Error.Message, "安装未完成", MessageBoxButtons.OK, MessageBoxIcon.Error);
            } else {
                progress.Value = 100;
                try {
                    InstallerCore.CreateShortcuts(target);
                    status.Text = "安装完成，桌面和开始菜单快捷方式已创建。";
                    MessageBox.Show(this, "安装完成。请从桌面“白球AI”打开。\n" + Convert.ToString(result.Result), "白球AI安装完成");
                } catch (Exception error) {
                    status.Text = "程序已安装，快捷方式创建失败。";
                    MessageBox.Show(this, "程序已安装到：" + target + "\n可打开其中的白球AI.exe。\n快捷方式错误：" + error.Message, "安装结果");
                }
            }
            worker.Dispose();
        };
        worker.RunWorkerAsync();
    }
}

internal static class InstallerCore
{
    internal static readonly string[] Required = {
        "白球AI.exe", "resources\\app\\package.json", "resources\\app\\main.js",
        "resources\\app\\preload.js", "resources\\app\\renderer-v2\\app.js",
        "resources\\app\\renderer-v2\\styles.css", "resources\\app\\node_modules\\marked\\package.json"
    };
    internal static string Normalize(string path) { return Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar); }
    internal static bool Within(string path, string root) {
        return path.Equals(root, StringComparison.OrdinalIgnoreCase) || path.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase);
    }
    internal static void ValidatePaths(string source, string target)
    {
        if (String.IsNullOrWhiteSpace(target) || !Path.IsPathRooted(target)) throw new IOException("请选择完整的安装目录。");
        source = Normalize(source);
        target = Normalize(target);
        if (Within(source, target) || Within(target, source)) throw new IOException("安装位置不能与硬盘上的程序目录重叠。");
        if (target.Length <= Path.GetPathRoot(target).Length) throw new IOException("不能安装到磁盘根目录，请选择专用文件夹。");
        for (var ancestor = new DirectoryInfo(target); ancestor != null; ancestor = ancestor.Parent)
            if (ancestor.Exists && (ancestor.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("安装目录不能经过目录链接，请选择真实文件夹。");
        if (Directory.Exists(target) && Directory.GetFileSystemEntries(target).Length > 0 && !File.Exists(Path.Combine(target, "白球AI.exe")))
            throw new IOException("所选文件夹已有其他文件，请选择空文件夹或现有白球AI安装目录。");
    }
    private static void CheckRunning(string target)
    {
        foreach (var process in Process.GetProcessesByName("白球AI"))
            using (process) {
                string executable;
                try { executable = process.MainModule.FileName; }
                catch (Win32Exception) { throw new IOException("无法检查正在运行的白球AI，请先退出白球再安装。"); }
                catch (InvalidOperationException) { continue; }
                if (Within(Normalize(executable), target)) throw new IOException("目标电脑上的白球AI仍在运行，请退出后重试。");
            }
    }
    internal static List<string> Inventory(string source, Action<int, string> report)
    {
        var files = new List<string>();
        var directories = new Queue<string>();
        var timer = Stopwatch.StartNew();
        directories.Enqueue(source);
        while (directories.Count > 0) {
            foreach (var entry in Directory.EnumerateFileSystemEntries(directories.Dequeue())) {
                var attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("安装源包含目录或文件链接，请先补齐真实文件，避免安装后缺少依赖：" + entry);
                if ((attributes & FileAttributes.Directory) != 0) directories.Enqueue(entry);
                else files.Add(entry.Substring(source.Length + 1));
            }
            if (timer.ElapsedMilliseconds >= 150) { report(-1, "正在检查安装源，已找到 " + files.Count + " 个文件"); timer.Restart(); }
        }
        return files;
    }
    private static byte[] Hash(string file)
    {
        using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (var hash = SHA256.Create()) return hash.ComputeHash(stream);
    }
    internal static string Install(string sourcePath, string targetPath, Action<int, string> report)
    {
        ValidatePaths(sourcePath, targetPath);
        var source = Normalize(sourcePath);
        var target = Normalize(targetPath);
        foreach (var relative in Required)
            if (!File.Exists(Path.Combine(source, relative))) throw new IOException("本硬盘的程序文件不完整，缺少：" + relative);
        CheckRunning(target);
        var files = Inventory(source, report);
        long size = 0;
        foreach (var file in files) size += new FileInfo(Path.Combine(source, file)).Length;
        var drive = new DriveInfo(Path.GetPathRoot(target));
        if (drive.AvailableFreeSpace < size + 64L * 1024 * 1024) throw new IOException("安装盘剩余空间不足，需要约 " + (size / 1024 / 1024 + 64) + " MB。");
        var staging = target + ".install-" + Guid.NewGuid().ToString("N");
        Directory.CreateDirectory(staging);
        try {
            long copied = 0;
            var timer = Stopwatch.StartNew();
            var buffer = new byte[1024 * 1024];
            foreach (var relative in files) {
                var output = Path.Combine(staging, relative);
                Directory.CreateDirectory(Path.GetDirectoryName(output));
                using (var input = new FileStream(Path.Combine(source, relative), FileMode.Open, FileAccess.Read, FileShare.Read))
                using (var destination = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                    int count;
                    while ((count = input.Read(buffer, 0, buffer.Length)) > 0) {
                        destination.Write(buffer, 0, count);
                        copied += count;
                        if (timer.ElapsedMilliseconds >= 150) {
                            report((int)(copied * 70 / Math.Max(1, size)), "正在复制 " + copied / 1024 / 1024 + " / " + size / 1024 / 1024 + " MB\n" + relative);
                            timer.Restart();
                        }
                    }
                    destination.Flush();
                }
            }
            for (var index = 0; index < files.Count; index++) {
                var relative = files[index];
                if (!Convert.ToBase64String(Hash(Path.Combine(source, relative))).Equals(Convert.ToBase64String(Hash(Path.Combine(staging, relative)))))
                    throw new IOException("文件校验不一致，安装源可能正在更新：" + relative);
                if (timer.ElapsedMilliseconds >= 150 || index == files.Count - 1) {
                    report(70 + (index + 1) * 29 / files.Count, "正在校验 " + (index + 1) + " / " + files.Count + "\n" + relative);
                    timer.Restart();
                }
            }
            ValidatePaths(source, target);
            CheckRunning(target);
            var backup = Promote(staging, target);
            report(100, "程序复制和校验完成。");
            return String.IsNullOrEmpty(backup) ? "个人资料没有从移动硬盘复制到电脑。" : "旧安装保留在：" + backup;
        } catch (Exception error) {
            throw new IOException(error.Message + "\n未完成的安装副本保留在：" + staging, error);
        }
    }
    internal static string Promote(string staging, string target)
    {
        var backup = Directory.Exists(target) ? target + ".backup-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0, 6) : "";
        if (backup.Length > 0) MoveDirectory(target, backup);
        try { MoveDirectory(staging, target); }
        catch { if (backup.Length > 0) MoveDirectory(backup, target); throw; }
        return backup;
    }
    private static void MoveDirectory(string source, string target)
    {
        for (var attempt = 0; ; attempt++) {
            try { Directory.Move(source, target); return; }
            catch (IOException) { if (attempt >= 8) throw; Thread.Sleep(250); }
        }
    }
    internal static void CreateShortcuts(string target)
    {
        dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        foreach (var folder in new[] { Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs") }) {
            Directory.CreateDirectory(folder);
            dynamic shortcut = shell.CreateShortcut(Path.Combine(folder, "白球AI.lnk"));
            shortcut.TargetPath = Path.Combine(target, "白球AI.exe");
            shortcut.WorkingDirectory = target;
            shortcut.IconLocation = Path.Combine(target, "白球AI.exe") + ",0";
            shortcut.Description = "白球AI";
            shortcut.Save();
        }
    }
}
