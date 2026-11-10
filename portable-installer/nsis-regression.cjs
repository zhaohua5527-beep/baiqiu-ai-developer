"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const project = "C:/Users/Lenovo/Desktop/白球AI-正式软件仓库/source-current";
const { build, Platform, Arch } = require(path.join(project, "node_modules/electron-builder"));
const { UUID } = require(path.join(project, "node_modules/builder-util-runtime"));
const root = path.resolve(__dirname, "upgrade-build", "nsis-fixture");
const guid = UUID.v5("com.baiqiu.installer-regression", UUID.parse("50e065bc-3134-11e6-9bab-38c9862bdaf3"));
async function main() {
  fs.mkdirSync(root, { recursive: true });
  const app = path.join(root, "app");
  fs.mkdirSync(path.join(app, "resources/app"), { recursive: true });
  const fixtureSource = path.join(root, "Fixture.cs");
  fs.writeFileSync(fixtureSource, 'class Fixture { static void Main() { System.Threading.Thread.Sleep(60000); } }');
  const compiler = path.join(process.env.WINDIR, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
  const compiled = spawnSync(compiler, ["/nologo", "/target:winexe", "/out:" + path.join(app, "BaiqiuUpgradeFixture.exe"), fixtureSource], { windowsHide: true, stdio: "inherit" });
  if (compiled.status !== 0) throw new Error("Fixture compile failed");
  for (const version of ["1.0.0", "1.0.1"]) {
    fs.writeFileSync(path.join(app, "resources/app/package.json"), JSON.stringify({ name: "baiqiu-upgrade-fixture", version, main: "main.js" }));
    fs.writeFileSync(path.join(app, "resources/app/main.js"), "fixture=" + version);
    await build({ projectDir: project, prepackaged: app, targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64), publish: "never", config: {
      appId: "com.baiqiu.installer-regression", productName: "BaiqiuUpgradeFixture", extraMetadata: { version, name: "baiqiu-upgrade-fixture" },
      directories: { output: path.join(root, "payload") }, win: { forceCodeSigning: false, signAndEditExecutable: false },
      nsis: { include: path.join(project, "build/installer.nsh"), oneClick: false, allowToChangeInstallationDirectory: false, packElevateHelper: false,
        runAfterFinish: false, shortcutName: "BaiqiuUpgradeFixture", deleteAppDataOnUninstall: false, installerLanguages: ["zh_CN"], language: "2052" },
      artifactName: "Fixture-${version}.${ext}"
    }});
  }
  fs.writeFileSync(path.join(root, "fixture.json"), JSON.stringify({ guid, root }));
  console.log(JSON.stringify({ ok: true, guid, root }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
