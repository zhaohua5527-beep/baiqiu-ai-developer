"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const project = "C:/Users/Lenovo/Desktop/白球AI-正式软件仓库/source-current";
const input = process.argv[2] || "F:/白球AI便携版/app";
const output = path.resolve(__dirname, "upgrade-build");
const snapshot = path.join(output, "app");
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function inventory(root, directory = root) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error("安装源包含链接：" + file);
    return entry.isDirectory() ? inventory(root, file) : [{ path: path.relative(root, file), size: fs.statSync(file).size, hash: hash(file) }];
  });
}
async function main() {
  fs.mkdirSync(output, { recursive: true });
  if (fs.existsSync(snapshot)) throw new Error("构建快照已存在，请指定新的构建目录或核查旧构建，避免混入旧文件。");
  const copied = spawnSync("robocopy.exe", [input, snapshot, "/E", "/COPY:DAT", "/DCOPY:DAT", "/R:1", "/W:1", "/XJ", "/NFL", "/NDL", "/NP", "/NJH", "/NJS"], { windowsHide: true, stdio: "inherit" });
  if (copied.status === null || copied.status >= 8) throw new Error("复制快照失败：" + copied.status);
  const files = inventory(snapshot);
  for (const entry of files) if (hash(path.join(input, entry.path)) !== entry.hash) throw new Error("复制期间安装源发生变化：" + entry.path);
  const metadata = JSON.parse(fs.readFileSync(path.join(snapshot, "resources/app/package.json"), "utf8"));
  const { build, Platform, Arch } = require(path.join(project, "node_modules/electron-builder"));
  await build({ projectDir: project, prepackaged: snapshot, targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64), publish: "never", config: {
    appId: "com.baiqiu.ai", productName: "白球AI", compression: "normal", extraMetadata: { version: metadata.version },
    directories: { output: path.join(output, "payload") },
    win: { forceCodeSigning: false, signAndEditExecutable: false },
    nsis: { include: path.join(project, "build/installer.nsh"), oneClick: false, allowToChangeInstallationDirectory: false,
      packElevateHelper: false, runAfterFinish: false, deleteAppDataOnUninstall: false, installerLanguages: ["zh_CN"], language: "2052" },
    artifactName: "BaiqiuAI-Setup-${version}.${ext}"
  }});
  const installer = path.join(output, "payload", `BaiqiuAI-Setup-${metadata.version}.exe`);
  const manifest = { version: metadata.version, installer: path.basename(installer), hash: hash(installer), guid: "47e76a39-27f8-5672-b9b0-dc99c558e785", files };
  fs.writeFileSync(path.join(output, "bundle.json"), JSON.stringify(manifest));
  console.log(JSON.stringify({ ok: true, files: files.length, bytes: files.reduce((total, file) => total + file.size, 0), installer, sha256: manifest.hash }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
