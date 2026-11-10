using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

internal static class UpgradeTests
{
    private static int checks;
    private static void Check(bool result, string name) { if (!result) throw new Exception(name); checks++; }
    private static void Reject(Action action, string name) { try { action(); } catch (IOException) { checks++; return; } throw new Exception("Expected rejection: " + name); }
    private static void Put(string root, string relative, string value) { var file = Path.Combine(root, relative); Directory.CreateDirectory(Path.GetDirectoryName(file)); File.WriteAllText(file, value); }
    private static Bundle CreateBundle(string source) {
        return new Bundle { version = "3.0.28", files = UpgradeCore.Inventory(source).Select(file => new BundleFile { path = file, size = new FileInfo(Path.Combine(source, file)).Length, hash = UpgradeCore.Hash(Path.Combine(source, file)) }).ToList() };
    }
    private static int Main(string[] args) {
        try { Run(args); return 0; }
        catch (Exception error) { Console.WriteLine("FAIL checks=" + checks + " " + error.GetType().Name + " " + error.Message + " " + error.StackTrace); return 1; }
    }
    private static void Run(string[] args) {
        var root = Path.GetFullPath(args[0]); Directory.CreateDirectory(root);
        var source = Path.Combine(root, "source");
        Put(source, "白球AI.exe", "new binary");
        Put(source, "resources\\app\\package.json", "{\"version\":\"3.0.28\"}");
        Put(source, "resources\\app\\renderer-v2\\app.js", "new UI");
        var bundle = CreateBundle(source); var target = Path.Combine(root, "target");
        var empty = new List<Installation>();
        var report = new Action<string>(text => {});
        Action<string, UpgradeJournal> noIntegration = (directory, savedJournal) => {};
        Action install = () => UpgradeCore.CopyVerified(source, target, UpgradeCore.Inventory(source), report);
        Check(UpgradeCore.Normalize("C:\\") == "C:\\", "drive root normalization");
        Check(!UpgradeCore.Within("C:\\app-two", "C:\\app"), "boundary sibling");
        Reject(() => UpgradeCore.ValidateTarget("C:\\", source, bundle, empty), "drive root rejection");
        Reject(() => UpgradeCore.ValidateTarget(source, source, bundle, empty), "source overlap");
        Reject(() => UpgradeCore.ValidateTarget("relative", source, bundle, empty), "relative target");
        Reject(() => UpgradeCore.ValidateTarget(Path.Combine(root, new string('x', 210)), source, bundle, empty), "path length preflight");
        var outside = new List<Installation> { new Installation { Path = Path.Combine(root,"another"), Registered = true } };
        Reject(() => UpgradeCore.ValidateTarget(target, source, bundle, outside), "other registered install never uninstalled implicitly");
        Put(target, "private.txt", "unrelated");
        Reject(() => UpgradeCore.ValidateTarget(target, source, bundle, empty), "unrelated data directory");
        Put(target, "白球AI.exe", "old binary");
        Put(target, "resources\\app\\package.json", "{\"version\":\"3.0.20\"}");
        Put(target, "profile\\memory.txt", "customer memory");
        Put(target, "data\\history.txt", "customer history");
        Put(target, "user-data\\settings.txt", "customer setting");
        Put(target, "location.json", "custom data location");
        Check(UpgradeCore.SelectedPath(target) == target, "folder chooser does not append duplicate Baiqiu folder");
        UpgradeCore.ValidateTarget(target, source, bundle, empty);
        var externalData = Path.Combine(root,"external-memory.txt"); File.WriteAllText(externalData,"external customer history");
        var transaction = UpgradeCore.TransactionDirectory(target);
        Action destructiveInstall = () => {
            Directory.Move(target, target + ".fixture-old");
            install();
        };
        UpgradeCore.InstallTransaction(target, bundle, report, destructiveInstall, noIntegration, noIntegration, false);
        UpgradeCore.VerifyInstalled(target, bundle, report); checks++;
        Check(File.ReadAllText(Path.Combine(target,"profile\\memory.txt")) == "customer memory", "profile restored after official uninstaller");
        Check(File.ReadAllText(Path.Combine(target,"data\\history.txt")) == "customer history", "data restored");
        Check(File.ReadAllText(Path.Combine(target,"user-data\\settings.txt")) == "customer setting", "user-data restored");
        Check(File.ReadAllText(Path.Combine(target,"location.json")) == "custom data location", "location retained");
        Check(File.ReadAllText(externalData) == "external customer history", "external data untouched");
        Check(File.ReadAllText(Path.Combine(transaction,"old\\private.txt")) == "unrelated", "unknown old files preserved in backup");
        Check(File.ReadAllText(Path.Combine(transaction,"old\\白球AI.exe")) == "old binary", "old binary backup verified");
        var integrationRestored = false;
        Reject(() => UpgradeCore.InstallTransaction(target, bundle, report, () => { Put(target,"白球AI.exe","broken"); throw new IOException("copy interrupted"); }, noIntegration,
            (directory,savedJournal) => integrationRestored=true, false), "install failure rollback");
        Check(integrationRestored,"integration restored");
        Check(File.ReadAllText(Path.Combine(target,"白球AI.exe")) == "new binary", "rollback binary exact");
        Check(File.ReadAllText(Path.Combine(target,"profile\\memory.txt")) == "customer memory", "rollback retains data");
        Reject(() => UpgradeCore.InstallTransaction(target, bundle, report, () => Put(target,"白球AI.exe","bad hash"), noIntegration, noIntegration, false), "post install corruption rollback");
        Check(File.ReadAllText(Path.Combine(target,"白球AI.exe")) == "new binary", "hash failure restored");
        var journalFile = Path.Combine(transaction,"transaction.json");
        var journal = UpgradeCore.Json.Deserialize<UpgradeJournal>(File.ReadAllText(journalFile));
        journal.State="安装中"; UpgradeCore.WriteJournal(transaction,journal);
        Reject(() => UpgradeCore.InstallTransaction(target,bundle,report,install,noIntegration,noIntegration,false),"interrupted transaction blocks new install");
        Put(target,"白球AI.exe","partial after power loss");
        UpgradeCore.Restore(transaction,journal,bundle,report,()=>{});
        Check(File.ReadAllText(Path.Combine(target,"白球AI.exe"))=="new binary","interrupted recovery");
        journal.Target=Path.Combine(root,"wrong");
        Reject(()=>UpgradeCore.Restore(transaction,journal,bundle,report,()=>{}),"recovery target binding");
        Put(target,"resources\\app\\package.json","{\"version\":\"9.0.0\"}");
        Reject(()=>UpgradeCore.ValidateTarget(target,source,bundle,empty),"downgrade prevented");
        Put(target,"resources\\app\\package.json","{\"version\":\"3.0.28\"}");
        var duplicate = new List<Installation> { new Installation {Path=target,Registered=true}, new Installation {Path=target,Registered=true,Machine=true} };
        Reject(()=>UpgradeCore.ValidateTarget(target,source,bundle,duplicate),"dual installation scope stopped");
        var fresh=Path.Combine(root,"fresh");
        Reject(()=>UpgradeCore.InstallTransaction(fresh,bundle,report,()=>{Put(fresh,"白球AI.exe","partial");throw new IOException("fail");},noIntegration,noIntegration,false),"fresh installation failure");
        Check(!Directory.Exists(fresh),"failed fresh install removed from active path");
        var tampered=Path.Combine(root,"tampered"); Put(tampered,"白球AI.exe","keep");
        var tamperedTransaction=UpgradeCore.TransactionDirectory(tampered);Directory.CreateDirectory(tamperedTransaction);
        Reject(()=>UpgradeCore.Restore(tamperedTransaction,new UpgradeJournal{Target=tampered,HadOld=true},bundle,report,()=>{}),"missing backup blocks destructive recovery");
        Check(File.ReadAllText(Path.Combine(tampered,"白球AI.exe"))=="keep","incomplete backup retains current binary");
        Put(target,"resources\\custom\\state.db","nonstandard customer data");
        Reject(()=>UpgradeCore.InstallTransaction(target,bundle,report,install,noIntegration,noIntegration,false),"nonstandard embedded data stops before uninstall");
        Check(File.ReadAllText(Path.Combine(target,"resources\\custom\\state.db"))=="nonstandard customer data","nonstandard data unchanged");
        Check(UpgradeCore.IsCustomerFile("heiqiu-db.json"),"root customer database retained");
        Check(!UpgradeCore.IsCustomerFile("resources\\app\\main.js"),"program file never treated as customer data");
        Console.WriteLine("PASS checks="+checks+"; isolated fixtures only; no real profile, registry, shortcuts or running clients modified");
    }
}
