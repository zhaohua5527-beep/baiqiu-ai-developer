using System;
using System.IO;
using Microsoft.Win32;

internal static class IntegrationTests
{
    [STAThread]
    private static int Main(string[] args) {
        var root = Path.GetFullPath(args[0]); Directory.CreateDirectory(root);
        var bundle = new Bundle { guid = Guid.NewGuid().ToString() };
        var paths = UpgradeCore.RegistryPaths(bundle.guid);
        try {
            foreach (var name in paths) using(var key = Registry.CurrentUser.CreateSubKey(name)) key.SetValue("InstallLocation", "fixture-original");
            var target = Path.Combine(root,"app"); Directory.CreateDirectory(target);
            var linkPath = Path.Combine(root,"fixture.lnk");
            var newLinkPath = Path.Combine(root,"new-fixture.lnk");
            dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
            dynamic link = shell.CreateShortcut(linkPath);
            link.TargetPath = Path.Combine(target,"白球AI.exe");
            link.Arguments = "--baiqiu-user-data-root=\"C:\\fixture custom data\"";
            link.Save();
            var journal = new UpgradeJournal{Target=target};
            UpgradeCore.SaveIntegration(root,journal,bundle,new[]{linkPath,newLinkPath});
            foreach (var name in paths) using(var key = Registry.CurrentUser.CreateSubKey(name)) key.SetValue("InstallLocation", "fixture-upgraded");
            dynamic altered = shell.CreateShortcut(linkPath); altered.Arguments="";altered.Save();
            dynamic newLink = shell.CreateShortcut(newLinkPath); newLink.TargetPath="C:\\fixture.exe";newLink.Save();
            UpgradeCore.PreserveShortcutArguments(root,journal);
            if ((string)shell.CreateShortcut(linkPath).Arguments != "--baiqiu-user-data-root=\"C:\\fixture custom data\"") throw new Exception("custom data arguments lost");
            UpgradeCore.RestoreIntegration(root,journal,bundle);
            foreach(var name in paths) using(var key=Registry.CurrentUser.OpenSubKey(name))
                if ((string)key.GetValue("InstallLocation")!="fixture-original") throw new Exception("registry not restored");
            if(File.Exists(newLinkPath))throw new Exception("new shortcut not rolled back");
            if ((string)shell.CreateShortcut(linkPath).Arguments != "--baiqiu-user-data-root=\"C:\\fixture custom data\"") throw new Exception("shortcut rollback lost arguments");
            Console.WriteLine("PASS integration checks=5; random isolated registry identity and fixture shortcuts only"); return 0;
        } catch(Exception error) {Console.WriteLine(error.ToString());return 1;}
        finally { foreach(var name in paths) Registry.CurrentUser.DeleteSubKeyTree(name,false); }
    }
}
