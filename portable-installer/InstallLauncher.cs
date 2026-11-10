using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class InstallLauncher
{
    [STAThread]
    private static void Main()
    {
        try
        {
            var root = AppDomain.CurrentDomain.BaseDirectory;
            var source = Path.Combine(root, "白球AI便携版", "app");
            var target = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "白球AI");
            var sourceExecutable = Path.Combine(source, "白球AI.exe");
            var targetExecutable = Path.Combine(target, "白球AI.exe");
            if (!File.Exists(sourceExecutable))
            {
                throw new InvalidOperationException("找不到本硬盘中的“白球AI便携版\\app”程序目录。");
            }

            Directory.CreateDirectory(target);
            var copy = Process.Start(new ProcessStartInfo
            {
                FileName = "robocopy.exe",
                Arguments = string.Format("\"{0}\" \"{1}\" /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XJ /NFL /NDL /NP", source, target),
                UseShellExecute = false,
                CreateNoWindow = true
            });
            copy.WaitForExit();
            if (copy.ExitCode > 7) throw new InvalidOperationException("程序复制失败，错误码：" + copy.ExitCode);

            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            dynamic shell = Activator.CreateInstance(shellType);
            var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            var startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs");
            Directory.CreateDirectory(startMenu);
            CreateShortcut(shell, Path.Combine(desktop, "白球AI.lnk"), targetExecutable);
            CreateShortcut(shell, Path.Combine(startMenu, "白球AI.lnk"), targetExecutable);
            MessageBox.Show("白球AI安装完成，桌面快捷方式已创建。\n\n聊天记录、长期记忆、API Key和浏览器登录状态未复制。", "白球AI", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "白球AI安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static void CreateShortcut(dynamic shell, string path, string target)
    {
        dynamic shortcut = shell.CreateShortcut(path);
        shortcut.TargetPath = target;
        shortcut.WorkingDirectory = Path.GetDirectoryName(target);
        shortcut.IconLocation = target + ",0";
        shortcut.Description = "白球AI";
        shortcut.Save();
    }
}
