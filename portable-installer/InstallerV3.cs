using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

internal sealed class BundleFile { public string path; public long size; public string hash; }
internal sealed class Bundle { public string version; public string installer; public string hash; public string guid; public List<BundleFile> files; }
internal sealed class Installation
{
    public string Path;
    public string Version;
    public bool Machine;
    public bool Registered;
    public override string ToString() { return (Registered ? "已安装 " : "已有程序 ") + Version + " — " + Path; }
}
internal sealed class SavedShortcut { public string Path; public string File; }
internal sealed class UpgradeJournal
{
    public string Target;
    public string State;
    public bool HadOld;
    public bool Machine;
    public List<SavedShortcut> Shortcuts = new List<SavedShortcut>();
}

internal static class UpgradeCore
{
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16000000 };
    internal static string Normalize(string value) {
        var full = System.IO.Path.GetFullPath(value);
        return full.Length == System.IO.Path.GetPathRoot(full).Length ? full : full.TrimEnd('\\');
    }
    internal static bool Within(string value, string root) { return value.Equals(root, StringComparison.OrdinalIgnoreCase) || value.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase); }
    internal static string Hash(string file) {
        using (var input = File.OpenRead(file)) using (var hash = SHA256.Create())
            return BitConverter.ToString(hash.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
    }
    internal static Bundle LoadBundle() {
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("bundle.json"))
        using (var reader = new StreamReader(stream)) {
            var bundle = Json.Deserialize<Bundle>(reader.ReadToEnd());
            if (String.IsNullOrWhiteSpace(bundle.guid) || bundle.files == null || bundle.files.Count == 0 || String.IsNullOrWhiteSpace(bundle.hash)) throw new IOException("安装包清单不完整，请重新构建。");
            return bundle;
        }
    }
    internal static string VersionAt(string directory) {
        try {
            var metadata = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(System.IO.Path.Combine(directory, "resources", "app", "package.json")));
            return Convert.ToString(metadata["version"]);
        } catch { return "未知版本"; }
    }
    internal static string SelectedPath(string selectedPath) {
        return File.Exists(System.IO.Path.Combine(selectedPath, "白球AI.exe")) ? selectedPath : System.IO.Path.Combine(selectedPath, "白球AI");
    }
    internal static string[] RegistryPaths(string guid) { return new[] { "Software\\" + guid, "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + guid }; }
    internal static List<string> ShortcutPaths() {
        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var folder in new[] { Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory),
            Environment.GetFolderPath(Environment.SpecialFolder.Programs), Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms) }) {
            if (String.IsNullOrEmpty(folder)) continue;
            result.Add(System.IO.Path.Combine(folder, "白球AI.lnk"));
            if (Directory.Exists(folder)) foreach (var file in Directory.GetFiles(folder, "*白球*.lnk")) result.Add(file);
        }
        return result.ToList();
    }
    internal static List<Installation> Discover(Bundle bundle) {
        var result = new List<Installation>();
        foreach (var machine in new[] { false, true }) foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 }) {
            using (var root = RegistryKey.OpenBaseKey(machine ? RegistryHive.LocalMachine : RegistryHive.CurrentUser, view)) {
                foreach (var keyName in RegistryPaths(bundle.guid)) using (var key = root.OpenSubKey(keyName)) {
                    var target = key == null ? "" : Convert.ToString(key.GetValue("InstallLocation"));
                    if (String.IsNullOrWhiteSpace(target)) continue;
                    target = Normalize(target);
                    if (!result.Any(item => item.Path.Equals(target, StringComparison.OrdinalIgnoreCase) && item.Machine == machine))
                        result.Add(new Installation { Path = target, Version = VersionAt(target), Machine = machine, Registered = true });
                }
            }
        }
        dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        foreach (var file in ShortcutPaths()) {
            if (!File.Exists(file)) continue;
            dynamic link = shell.CreateShortcut(file);
            string executable = link.TargetPath;
            if (!System.IO.Path.GetFileName(executable).Equals("白球AI.exe", StringComparison.OrdinalIgnoreCase)) continue;
            var target = Normalize(System.IO.Path.GetDirectoryName(executable));
            if (!result.Any(item => item.Path.Equals(target, StringComparison.OrdinalIgnoreCase)) && File.Exists(executable))
                result.Add(new Installation { Path = target, Version = VersionAt(target) });
        }
        var defaultTarget = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "白球AI");
        if (File.Exists(System.IO.Path.Combine(defaultTarget, "白球AI.exe")) && !result.Any(item => item.Path.Equals(defaultTarget, StringComparison.OrdinalIgnoreCase)))
            result.Add(new Installation { Path = defaultTarget, Version = VersionAt(defaultTarget) });
        return result;
    }
    internal static void CheckRunning() {
        var running = Process.GetProcessesByName("白球AI");
        var count = running.Length;
        foreach (var process in running) process.Dispose();
        if (count > 0) throw new IOException("白球AI仍有 " + count + " 个进程运行。请保存任务，并从托盘菜单选择退出（只关闭窗口不够），然后重试。不会强制结束任务。");
    }
    internal static List<string> Inventory(string root) {
        var result = new List<string>();
        var pending = new Queue<string>(); pending.Enqueue(root);
        while (pending.Count > 0) foreach (var entry in Directory.EnumerateFileSystemEntries(pending.Dequeue())) {
            var attributes = File.GetAttributes(entry);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("目录中含有链接，无法安全备份或替换：" + entry);
            if ((attributes & FileAttributes.Directory) != 0) pending.Enqueue(entry);
            else result.Add(entry.Substring(root.Length + 1));
        }
        return result;
    }
    internal static void ValidateTarget(string target, string media, Bundle bundle, List<Installation> existing) {
        if (String.IsNullOrWhiteSpace(target) || !System.IO.Path.IsPathRooted(target) || target.IndexOf('"') >= 0 || target.StartsWith("\\\\")) throw new IOException("请选择本机磁盘上的完整安装路径。");
        target = Normalize(target); media = Normalize(media);
        if (target.Length <= System.IO.Path.GetPathRoot(target).Length || Within(target, media) || Within(media, target)) throw new IOException("请安装到电脑上的专用目录，不能覆盖移动硬盘或磁盘根目录。");
        if (File.Exists(target)) throw new IOException("安装位置是文件，请选择专用目录。");
        foreach (var file in bundle.files) {
            var output = Normalize(System.IO.Path.Combine(target, file.path));
            if (!Within(output, target) || output.Length >= 245 || System.IO.Path.GetDirectoryName(output).Length >= 235)
                throw new IOException("安装路径过长或无效，请改用较短目录（例如 C:\\白球AI）。超限文件：" + file.path);
        }
        for (var parent = new DirectoryInfo(target); parent != null; parent = parent.Parent)
            if (parent.Exists && (parent.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("安装路径经过目录链接，请选择真实目录。");
        if (Directory.Exists(target) && Directory.GetFileSystemEntries(target).Length > 0 && !File.Exists(System.IO.Path.Combine(target, "白球AI.exe")))
            throw new IOException("该目录已有其他文件，请选择旧版白球程序目录或空目录。");
        if (existing.Count(item => item.Registered && item.Path.Equals(target, StringComparison.OrdinalIgnoreCase)) > 1)
            throw new IOException("该目录同时存在当前用户与所有用户的安装记录，请先整理重复记录后升级。");
        foreach (var old in existing.Where(item => item.Registered))
            if (!old.Path.Equals(target, StringComparison.OrdinalIgnoreCase)) throw new IOException("另有正式安装记录位于：" + old.Path + "。请先选择该旧版目录；多个正式安装并存时需先整理，避免升级器卸载其他副本。");
        Version installed, incoming;
        if (Version.TryParse(VersionAt(target), out installed) && Version.TryParse(bundle.version, out incoming) && installed > incoming)
            throw new IOException("本机版本 " + installed + " 高于安装包 " + incoming + "，已阻止降级。");
    }
    internal static string TransactionDirectory(string target) {
        using (var hash = SHA256.Create()) {
            var identity = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Normalize(target).ToUpperInvariant()))).Replace("-", "").Substring(0, 12);
            return System.IO.Path.Combine(System.IO.Path.GetDirectoryName(Normalize(target)), ".baiqiu-upgrade-" + identity);
        }
    }
    internal static bool IsCustomerFile(string file) {
        return new[] { "data\\", "profile\\", "user-data\\" }.Any(prefix => file.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            || new[] { "location.json", "heiqiu-db.json", "heiqiu-db.sqlite", "model-settings.json" }.Any(name => file.Equals(name, StringComparison.OrdinalIgnoreCase));
    }
    internal static void WriteJournal(string directory, UpgradeJournal journal) {
        var file = System.IO.Path.Combine(directory, "transaction.json");
        var temporary = file + ".tmp";
        using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None)) {
            var data = Encoding.UTF8.GetBytes(Json.Serialize(journal)); stream.Write(data, 0, data.Length); stream.Flush(true);
        }
        if (File.Exists(file)) File.Replace(temporary, file, null); else File.Move(temporary, file);
    }
    internal static void CopyVerified(string source, string target, IEnumerable<string> files, Action<string> report) {
        var timer = Stopwatch.StartNew();
        foreach (var relative in files) {
            var input = System.IO.Path.Combine(source, relative);
            var output = System.IO.Path.Combine(target, relative);
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(output));
            File.Copy(input, output, true);
            if (Hash(input) != Hash(output)) throw new IOException("备份或恢复校验失败：" + relative);
            if (timer.ElapsedMilliseconds > 200) { report("正在备份/恢复：" + relative); timer.Restart(); }
        }
    }
    internal static int Run(string file, string arguments) {
        using (var process = Process.Start(new ProcessStartInfo(file, arguments) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = System.IO.Path.GetDirectoryName(file) })) {
            process.WaitForExit(); return process.ExitCode;
        }
    }
    internal static string RegExe { get { return System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "reg.exe"); } }
    internal static void SaveIntegration(string directory, UpgradeJournal journal, Bundle bundle, IEnumerable<string> shortcuts = null) {
        for (var index = 0; index < 2; index++) foreach (var view in new[] { 32, 64 }) {
            var name = RegistryPaths(bundle.guid)[index];
            using (var root = RegistryKey.OpenBaseKey(journal.Machine ? RegistryHive.LocalMachine : RegistryHive.CurrentUser, view == 64 ? RegistryView.Registry64 : RegistryView.Registry32))
            using (var key = root.OpenSubKey(name)) {
                if (key == null) continue;
                var output = System.IO.Path.Combine(directory, "registry-" + view + "-" + index + ".reg");
                if (Run(RegExe, "export \"" + (journal.Machine ? "HKLM\\" : "HKCU\\") + name + "\" \"" + output + "\" /y /reg:" + view) != 0) throw new IOException("无法备份旧安装记录，请检查权限。");
            }
        }
        foreach (var file in shortcuts ?? ShortcutPaths()) {
            var saved = new SavedShortcut { Path = file, File = "shortcut-" + journal.Shortcuts.Count + ".lnk" };
            journal.Shortcuts.Add(saved);
            if (File.Exists(file)) File.Copy(file, System.IO.Path.Combine(directory, saved.File));
        }
    }
    internal static void RestoreIntegration(string directory, UpgradeJournal journal, Bundle bundle) {
        for (var index = 0; index < 2; index++) foreach (var view in new[] { 32, 64 }) {
            using (var root = RegistryKey.OpenBaseKey(journal.Machine ? RegistryHive.LocalMachine : RegistryHive.CurrentUser, view == 64 ? RegistryView.Registry64 : RegistryView.Registry32))
                root.DeleteSubKeyTree(RegistryPaths(bundle.guid)[index], false);
            var file = System.IO.Path.Combine(directory, "registry-" + view + "-" + index + ".reg");
            if (File.Exists(file) && Run(RegExe, "import \"" + file + "\" /reg:" + view) != 0) throw new IOException("恢复安装记录失败，备份保留在：" + directory);
        }
        foreach (var shortcut in journal.Shortcuts) {
            var saved = System.IO.Path.Combine(directory, shortcut.File);
            if (File.Exists(saved)) File.Copy(saved, shortcut.Path, true);
            else if (File.Exists(shortcut.Path)) File.Delete(shortcut.Path);
        }
    }
    internal static void VerifyInstalled(string target, Bundle bundle, Action<string> report) {
        var timer = Stopwatch.StartNew();
        foreach (var file in bundle.files) {
            var output = System.IO.Path.Combine(target, file.path);
            if (!File.Exists(output) || new FileInfo(output).Length != file.size || Hash(output) != file.hash) throw new IOException("安装后文件校验失败：" + file.path);
            if (timer.ElapsedMilliseconds > 200) { report("正在核验新版文件：" + file.path); timer.Restart(); }
        }
    }
    internal static void PreserveShortcutArguments(string directory, UpgradeJournal journal) {
        dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        foreach (var saved in journal.Shortcuts) {
            var file = System.IO.Path.Combine(directory, saved.File);
            if (!File.Exists(file)) continue;
            dynamic old = shell.CreateShortcut(file);
            string executable = old.TargetPath;
            if (!String.Equals(executable, System.IO.Path.Combine(journal.Target, "白球AI.exe"), StringComparison.OrdinalIgnoreCase)) continue;
            File.Copy(file, saved.Path, true);
        }
    }
    internal static void Restore(string directory, UpgradeJournal journal, Bundle bundle, Action<string> report, Action restoreIntegration) {
        if (!Normalize(directory).Equals(TransactionDirectory(journal.Target), StringComparison.OrdinalIgnoreCase)) throw new IOException("恢复记录与安装位置不匹配。");
        var backup = System.IO.Path.Combine(directory, "old");
        if (journal.HadOld && !File.Exists(System.IO.Path.Combine(backup, "白球AI.exe"))) throw new IOException("旧版备份不完整，已停止恢复，当前程序保持不动：" + backup);
        journal.State = "正在恢复"; WriteJournal(directory, journal);
        if (Directory.Exists(journal.Target)) Directory.Move(journal.Target, journal.Target + ".failed-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        if (journal.HadOld) {
            CopyVerified(backup, journal.Target, Inventory(backup), report);
        }
        restoreIntegration(); journal.State = "已恢复"; WriteJournal(directory, journal);
    }
    internal static void InstallTransaction(string target, Bundle bundle, Action<string> report, Action install,
        Action<string, UpgradeJournal> saveIntegration, Action<string, UpgradeJournal> restoreIntegration, bool machine) {
        target = Normalize(target);
        var directory = TransactionDirectory(target);
        if (Directory.Exists(directory)) {
            var journalFile = System.IO.Path.Combine(directory, "transaction.json");
            var previous = File.Exists(journalFile) ? Json.Deserialize<UpgradeJournal>(File.ReadAllText(journalFile)) : null;
            if (previous == null || (previous.State != "完成" && previous.State != "已恢复" && previous.State != "准备中"))
                throw new IOException("发现上次未完成的升级，请先点击“恢复上次升级”。记录：" + directory);
            Directory.Move(directory, directory + "-" + DateTime.Now.ToString("yyyyMMddHHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0, 4));
        }
        var files = Directory.Exists(target) ? Inventory(target) : new List<string>();
        foreach (var file in files) {
            var name = System.IO.Path.GetFileName(file);
            if (!IsCustomerFile(file) && new[] { "heiqiu-db.json", "state.db", "model-settings.json" }.Contains(name, StringComparer.OrdinalIgnoreCase))
                throw new IOException("检测到非标准位置的客户资料，已停止覆盖：" + file + "。请先确认数据目录迁移方案，原程序未修改。");
        }
        foreach (var file in files) if (System.IO.Path.Combine(directory, "old", file).Length >= 245)
            throw new IOException("旧版文件的备份路径过长，尚未修改旧版：" + file);
        var oldSize = files.Sum(file => new FileInfo(System.IO.Path.Combine(target, file)).Length);
        var required = bundle.files.Sum(file => file.size) + oldSize * 2 + 256L * 1024 * 1024;
        if (new DriveInfo(System.IO.Path.GetPathRoot(target)).AvailableFreeSpace < required) throw new IOException("目标盘空间不足，含备份和恢复预留需要约 " + required / 1024 / 1024 + " MB。");
        Directory.CreateDirectory(directory);
        var journal = new UpgradeJournal { Target = target, HadOld = Directory.Exists(target), Machine = machine, State = "准备中" };
        WriteJournal(directory, journal);
        if (journal.HadOld) { Directory.CreateDirectory(System.IO.Path.Combine(directory, "old")); CopyVerified(target, System.IO.Path.Combine(directory, "old"), files, report); }
        saveIntegration(directory, journal);
        journal.State = "安装中"; WriteJournal(directory, journal);
        try {
            install();
            VerifyInstalled(target, bundle, report);
            if (journal.HadOld) {
                var retained = files.Where(IsCustomerFile);
                CopyVerified(System.IO.Path.Combine(directory, "old"), target, retained, report);
            }
            journal.State = "完成"; WriteJournal(directory, journal);
        } catch (Exception error) {
            report("升级未完成，正在恢复旧程序和安装记录。");
            try { Restore(directory, journal, bundle, report, () => restoreIntegration(directory, journal)); }
            catch (Exception restoreError) { throw new IOException("升级失败且恢复未完成。请勿删除备份：" + directory + "\n失败：" + error.Message + "\n恢复：" + restoreError.Message, error); }
            throw new IOException("升级未完成，已恢复升级前状态。\n原因：" + error.Message + "\n备份：" + directory, error);
        }
    }
}

internal static class InstallerEntry
{
    [STAThread]
    private static void Main(string[] args) {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        bool created;
        using (var mutex = new Mutex(true, "Local\\BaiqiuPortableInstaller", out created)) {
            if (!created && !(args.Length == 2 && mutex.WaitOne(10000))) { MessageBox.Show("安装窗口已经打开，请返回已有窗口。", "白球AI安装"); return; }
            try { Application.Run(new UpgradeWindow(args)); }
            catch (Exception error) { MessageBox.Show("安装入口无法启动：" + error.Message, "白球AI安装"); }
        }
    }
}

internal sealed class UpgradeWindow : Form
{
    private readonly Bundle bundle = UpgradeCore.LoadBundle();
    private readonly ComboBox destination = new ComboBox();
    private readonly Label status = new Label();
    private readonly Button install = new Button();
    private readonly Button browse = new Button();
    private readonly Button recover = new Button();
    private readonly Button launch = new Button();
    private readonly Button elevate = new Button();
    private readonly ProgressBar progress = new ProgressBar();
    private List<Installation> existing;
    private bool working;
    private string installedTarget;
    private readonly string log;
    private readonly string media = AppDomain.CurrentDomain.BaseDirectory;

    internal UpgradeWindow(string[] args) {
        Text = "白球AI安装 / 升级"; ClientSize = new Size(760, 360); Font = new Font("Microsoft YaHei UI", 10);
        FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; StartPosition = FormStartPosition.CenterScreen;
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        var logs = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BaiqiuInstaller", "logs");
        Directory.CreateDirectory(logs); log = System.IO.Path.Combine(logs, DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Process.GetCurrentProcess().Id + ".log");
        var title = new Label { Text = "安装白球AI " + bundle.version + " · 已有旧版时原位升级", AutoSize = true, Left = 22, Top = 20 };
        var note = new Label { Text = "保留客户资料，不复制移动硬盘上的个人记忆和密钥。\n请先保存任务并从托盘退出白球；升级前备份，失败时恢复。", AutoSize = true, Left = 22, Top = 52 };
        destination.SetBounds(22, 110, 595, 30); browse.SetBounds(628, 108, 110, 32); browse.Text = "选择位置";
        status.SetBounds(22, 152, 716, 74);
        progress.SetBounds(22, 234, 716, 16);
        var copy = new Button { Text = "复制诊断" }; copy.SetBounds(22, 278, 100, 34);
        elevate.Text = "管理员运行"; elevate.SetBounds(128, 278, 110, 34);
        recover.Text = "恢复上次升级"; recover.SetBounds(244, 278, 120, 34);
        launch.Text = "启动白球"; launch.SetBounds(500, 278, 110, 34); launch.Enabled = false;
        install.Text = "开始安装 / 升级"; install.SetBounds(616, 278, 122, 34);
        Controls.AddRange(new Control[] { title, note, destination, browse, status, progress, copy, elevate, recover, launch, install });
        copy.Click += delegate { Clipboard.SetText(File.Exists(log) ? File.ReadAllText(log) : "尚未执行安装。"); };
        browse.Click += delegate {
            using (var picker = new FolderBrowserDialog { Description = "选择旧版白球所在目录；选择普通文件夹时会建立白球AI子目录。" })
                if (picker.ShowDialog(this) == DialogResult.OK) destination.Text = UpgradeCore.SelectedPath(picker.SelectedPath);
        };
        destination.SelectedIndexChanged += delegate {
            var selected = destination.SelectedItem as Installation;
            if (selected != null) { destination.Text = selected.Path; status.Text = selected.ToString(); }
        };
        Shown += delegate {
            try {
                existing = UpgradeCore.Discover(bundle).Where(item => !UpgradeCore.Within(item.Path, UpgradeCore.Normalize(media))).ToList();
                foreach (var item in existing) destination.Items.Add(item);
                if (args.Length == 2) {
                    if (args[1] != WindowsIdentity.GetCurrent().User.Value) throw new IOException("请使用原 Windows 账号提权，不能切换为其他管理员账号安装，否则会改变用户资料归属。");
                    destination.Text = args[0];
                } else if (existing.Count == 1) destination.SelectedIndex = 0;
                else if (existing.Count > 1) { destination.Text = ""; status.Text = "发现多个白球目录，请先从下拉列表选择需要升级的版本。"; }
                else { destination.Text = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "白球AI"); status.Text = "未发现旧版安装记录，可安装到默认位置，或手动选择旧版目录。"; }
                Record("就绪", "安装包版本=" + bundle.version + "；发现目录=" + existing.Count);
            } catch (Exception error) { install.Enabled = false; status.Text = error.Message; Record("检测失败", error.Message); }
        };
        elevate.Click += delegate {
            try {
                if (new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)) { status.Text = "当前已经是管理员权限。"; return; }
                var target = destination.SelectedItem as Installation;
                var path = target != null && destination.Text == target.ToString() ? target.Path : destination.Text;
                Process.Start(new ProcessStartInfo(Application.ExecutablePath, "\"" + path.Replace("\"", "") + "\" " + WindowsIdentity.GetCurrent().User.Value) { UseShellExecute = true, Verb = "runas" });
                Close();
            } catch (Win32Exception error) { status.Text = error.NativeErrorCode == 1223 ? "已取消管理员授权，未开始安装。" : "管理员启动失败：" + error.Message; }
        };
        install.Click += delegate { Begin(false); }; recover.Click += delegate { Begin(true); };
        launch.Click += delegate {
            try {
                Process.Start(new ProcessStartInfo(System.IO.Path.Combine(installedTarget, "白球AI.exe")) { UseShellExecute = true, WorkingDirectory = installedTarget });
                status.Text = "已发出启动请求。请确认白球窗口正常打开；尚未验证模型连接。";
            } catch (Exception error) { status.Text = "程序已安装，但启动失败：" + error.Message; Record("启动失败", error.Message); }
        };
        FormClosing += delegate(object sender, FormClosingEventArgs eventArgs) { if (working) { eventArgs.Cancel = true; status.Text = "正在备份、安装或恢复，请等待完成后关闭。"; } };
    }
    private void Record(string stage, string detail) { File.AppendAllText(log, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " [" + stage + "] " + detail + Environment.NewLine, Encoding.UTF8); }
    private void Begin(bool restoreOnly) {
        if (working) return;
        var target = destination.Text.Trim();
        var chosen = destination.SelectedItem as Installation;
        if (chosen != null && target == chosen.ToString()) target = chosen.Path;
        try {
            launch.Enabled = false;
            if (restoreOnly) {
                if (String.IsNullOrWhiteSpace(target) || !System.IO.Path.IsPathRooted(target)) throw new IOException("请指定上次升级的完整目录。");
                target = UpgradeCore.Normalize(target);
                if (target.Length <= System.IO.Path.GetPathRoot(target).Length || UpgradeCore.Within(target, UpgradeCore.Normalize(media)) || UpgradeCore.Within(UpgradeCore.Normalize(media), target)) throw new IOException("恢复位置不能是磁盘根目录或移动安装源。");
            } else UpgradeCore.ValidateTarget(target, media, bundle, existing ?? new List<Installation>());
            UpgradeCore.CheckRunning();
        } catch (Exception error) { status.Text = error.Message; Record("预检失败", error.Message); MessageBox.Show(this, error.Message, "尚未开始安装"); return; }
        working = true; destination.Enabled = browse.Enabled = install.Enabled = recover.Enabled = elevate.Enabled = launch.Enabled = false;
        progress.Style = ProgressBarStyle.Marquee;
        var worker = new BackgroundWorker { WorkerReportsProgress = true };
        worker.ProgressChanged += delegate(object sender, ProgressChangedEventArgs progressArgs) { status.Text = Convert.ToString(progressArgs.UserState); };
        worker.DoWork += delegate {
            Action<string> report = text => worker.ReportProgress(0, text);
            var transaction = UpgradeCore.TransactionDirectory(target);
            if (restoreOnly) {
                var file = System.IO.Path.Combine(transaction, "transaction.json");
                if (!File.Exists(file)) throw new IOException("此安装位置没有待恢复的升级记录。");
                var journal = UpgradeCore.Json.Deserialize<UpgradeJournal>(File.ReadAllText(file));
                if (!UpgradeCore.Normalize(journal.Target).Equals(UpgradeCore.Normalize(target), StringComparison.OrdinalIgnoreCase)) throw new IOException("恢复记录与所选目录不一致。");
                if (journal.Machine && !new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)) throw new UnauthorizedAccessException("此恢复需要管理员权限，请使用同一账号点击“管理员运行”。");
                if (journal.State == "准备中" || journal.State == "已恢复" || journal.State == "完成") throw new IOException("此记录不需要故障恢复。旧版备份仍保留在：" + transaction);
                UpgradeCore.Restore(transaction, journal, bundle, report, () => UpgradeCore.RestoreIntegration(transaction, journal, bundle));
                Record("恢复完成", target); return;
            }
            Record("开始", "目标=" + target); report("正在验证正式安装包，尚未修改旧版。");
            var selected = (existing ?? new List<Installation>()).FirstOrDefault(item => item.Path.Equals(target, StringComparison.OrdinalIgnoreCase) && item.Registered);
            var machine = selected != null && selected.Machine;
            if (machine && !new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)) throw new UnauthorizedAccessException("旧版为所有用户安装，请点击“管理员运行”后重试。");
            var parent = System.IO.Path.GetDirectoryName(UpgradeCore.Normalize(target));
            Directory.CreateDirectory(parent);
            var probe = System.IO.Path.Combine(parent, ".baiqiu-write-probe-" + Guid.NewGuid().ToString("N"));
            using (var stream = new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose)) { stream.WriteByte(1); }
            var payload = System.IO.Path.Combine(media, "白球AI开发资料", "安装器", "升级内核-20261019", bundle.installer);
            if (!File.Exists(payload) || UpgradeCore.Hash(payload) != bundle.hash) throw new IOException("正式安装包缺失或校验失败，请重新复制完整安装资料。文件：" + payload);
            if (new DriveInfo(System.IO.Path.GetPathRoot(System.IO.Path.GetTempPath())).AvailableFreeSpace < new FileInfo(payload).Length + bundle.files.Sum(file => file.size) + 128L * 1024 * 1024)
                throw new IOException("系统临时目录所在磁盘空间不足，请腾出安装包解压空间后重试。");
            var cache = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "baiqiu-install-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(cache);
            var localPayload = System.IO.Path.Combine(cache, bundle.installer); File.Copy(payload, localPayload);
            if (UpgradeCore.Hash(localPayload) != bundle.hash) throw new IOException("安装包本机暂存校验失败，可能是移动硬盘读取异常。");
            UpgradeCore.InstallTransaction(target, bundle, report, () => {
                UpgradeCore.CheckRunning(); report("正在执行正式安装器，请等待完成；不会启动模型或自动运行白球。"); Record("正式安装", "开始");
                var exitCode = UpgradeCore.Run(localPayload, "/S " + (machine ? "/allusers" : "/currentuser") + " /D=" + UpgradeCore.Normalize(target));
                Record("正式安装", "退出码=" + exitCode);
                if (exitCode != 0) throw new IOException("正式安装器未完成，退出码=" + exitCode);
                var journal = UpgradeCore.Json.Deserialize<UpgradeJournal>(File.ReadAllText(System.IO.Path.Combine(transaction, "transaction.json")));
                UpgradeCore.PreserveShortcutArguments(transaction, journal);
                var installedRecords = UpgradeCore.Discover(bundle);
                if (!installedRecords.Any(item => item.Registered && item.Path.Equals(target, StringComparison.OrdinalIgnoreCase))) throw new IOException("安装记录未指向目标目录。");
                if (!File.Exists(System.IO.Path.Combine(target, "Uninstall 白球AI.exe"))) throw new IOException("正式卸载程序缺失。");
            }, (directory, journal) => UpgradeCore.SaveIntegration(directory, journal, bundle),
                (directory, journal) => UpgradeCore.RestoreIntegration(directory, journal, bundle), machine);
            installedTarget = target; Record("完成", "文件校验通过；启动尚未验证；备份=" + transaction);
        };
        worker.RunWorkerCompleted += delegate(object sender, RunWorkerCompletedEventArgs result) {
            working = false; destination.Enabled = browse.Enabled = install.Enabled = recover.Enabled = elevate.Enabled = true;
            progress.Style = ProgressBarStyle.Continuous;
            if (result.Error != null) {
                var error = result.Error;
                var detail = error is UnauthorizedAccessException ? "安装目录或注册表权限不足，请点击“管理员运行”。\n" + error.Message : error.Message;
                status.Text = "安装/恢复未完成，请查看提示或复制诊断。"; Record("失败", error.GetType().Name + " HResult=" + error.HResult.ToString("X8") + " " + detail);
                MessageBox.Show(this, detail + "\n诊断日志：" + log, "白球AI安装结果", MessageBoxButtons.OK, MessageBoxIcon.Error);
            } else {
                progress.Value = 100; launch.Enabled = !restoreOnly;
                status.Text = restoreOnly ? "已恢复升级前程序及安装信息。" : "安装和文件校验完成。点击“启动白球”检查运行；客户资料保留，旧版备份保留。";
            }
            worker.Dispose();
        };
        worker.RunWorkerAsync();
    }
}
