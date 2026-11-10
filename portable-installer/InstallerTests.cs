using System;
using System.IO;
using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;

internal static class InstallerTests
{
    private static int checks;
    private static void Check(bool value, string name) { if (!value) throw new Exception(name); checks++; }
    private static void Reject(Action action, string name) {
        try { action(); } catch (IOException) { checks++; return; }
        throw new Exception("Expected rejection: " + name);
    }
    [STAThread]
    private static void Main(string[] args)
    {
        var root = Path.GetFullPath(args[0]);
        Directory.CreateDirectory(root);
        var source = Path.Combine(root, "盘符变化与空格 测试", "白球AI便携版", "app");
        foreach (var relative in InstallerCore.Required) {
            var file = Path.Combine(source, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            File.WriteAllText(file, "测试最新内容 " + relative);
        }
        var target = Path.Combine(root, "本机安装");
        Reject(() => InstallerCore.ValidatePaths(source, source), "same folder");
        Reject(() => InstallerCore.ValidatePaths(source, Path.Combine(source, "child")), "overlap");
        Reject(() => InstallerCore.ValidatePaths(source, Path.GetPathRoot(source)), "drive root");
        var unrelated = Path.Combine(root, "已有文档");
        Directory.CreateDirectory(unrelated);
        File.WriteAllText(Path.Combine(unrelated, "document.txt"), "retain");
        Reject(() => InstallerCore.ValidatePaths(source, unrelated), "unrelated directory");
        var lastProgress = -1;
        InstallerCore.Install(source, target, (percent, text) => { lastProgress = percent; });
        Check(lastProgress == 100, "successful progress");
        foreach (var relative in InstallerCore.Required)
            Check(File.ReadAllText(Path.Combine(source, relative)) == File.ReadAllText(Path.Combine(target, relative)), "exact copied content");
        File.WriteAllText(Path.Combine(target, "old.txt"), "old version");
        var revision = Path.Combine(source, "resources", "app", "renderer-v2", "app.js");
        File.WriteAllText(revision, "updated renderer");
        var receipt = InstallerCore.Install(source, target, (percent, text) => {});
        Check(File.ReadAllText(Path.Combine(target, "resources", "app", "renderer-v2", "app.js")) == "updated renderer", "upgrade latest");
        Check(!File.Exists(Path.Combine(target, "old.txt")), "no stale installation files");
        Check(receipt.Contains("backup-"), "backup reported");
        Check(Directory.GetDirectories(root, "本机安装.backup-*").Length == 1, "old installation kept");
        var oldExecutable = File.ReadAllText(Path.Combine(target, "白球AI.exe"));
        using (var locked = new FileStream(revision, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            Reject(() => InstallerCore.Install(source, target, (percent, text) => {}), "copy failure");
        Check(File.ReadAllText(Path.Combine(target, "白球AI.exe")) == oldExecutable, "copy failure preserves old install");
        Reject(() => InstallerCore.Promote(Path.Combine(root, "missing-stage"), target), "promotion failure");
        Check(File.Exists(Path.Combine(target, "白球AI.exe")), "promotion rolls back");
        var missing = Path.Combine(root, "不完整源"); Directory.CreateDirectory(missing);
        Reject(() => InstallerCore.Install(missing, Path.Combine(root, "unused-target"), (percent, text) => {}), "missing dependency");
        var link = Path.Combine(source, "dependency-link");
        using (var command = Process.Start(new ProcessStartInfo {
            FileName = "cmd.exe", Arguments = "/c mklink /J \"" + link + "\" \"" + unrelated + "\"",
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true
        })) {
            command.StandardOutput.ReadToEnd(); command.WaitForExit();
            Check(command.ExitCode == 0, "junction fixture");
        }
        Reject(() => InstallerCore.Inventory(source, (percent, text) => {}), "links fail explicitly rather than omitted");
        Application.EnableVisualStyles();
        using (var form = new InstallerWindow()) {
            form.ShowInTaskbar = false;
            form.Opacity = 0;
            form.Show();
            Application.DoEvents();
            using (var bitmap = new Bitmap(form.Width, form.Height)) {
                form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
                bitmap.Save(Path.Combine(root, "installer.png"));
            }
            Check(form.Text == "安装白球AI", "Chinese UI");
            Check(form.Controls.Count == 7, "installer controls visible");
            form.Close();
        }
        if (args.Length > 1) {
            var inventory = InstallerCore.Inventory(InstallerCore.Normalize(args[1]), (percent, text) => {});
            foreach (var relative in InstallerCore.Required) Check(File.Exists(Path.Combine(args[1], relative)), "real F source required file");
            Console.WriteLine("F source preflight files=" + inventory.Count);
        }
        Console.WriteLine("PASS checks=" + checks + "; no live install, no production shortcut changes");
    }
}
