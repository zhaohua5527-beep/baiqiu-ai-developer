"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function loadUpdater(userData) {
  const originalLoad = Module._load;
  const updaterPath = require.resolve("../services/updater");
  delete require.cache[updaterPath];
  Module._load = function loadElectronStub(request, parent, isMain) {
    if (request === "electron") {
      return { app: { getVersion: () => "3.0.5", getPath: () => userData } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require("../services/updater");
  } finally {
    Module._load = originalLoad;
  }
}

test("downloadUpdate resumes a verified partial package with HTTP Range", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-update-resume-"));
  const userData = path.join(root, "user-data");
  const updates = path.join(userData, "updates");
  const content = crypto.randomBytes(192 * 1024);
  const partialLength = 24 * 1024;
  const checksum = crypto.createHash("sha256").update(content).digest("hex");
  fs.mkdirSync(updates, { recursive: true });
  fs.writeFileSync(path.join(updates, "update.zip.part"), content.subarray(0, partialLength));

  let requestedOffset = -1;
  const server = http.createServer((request, response) => {
    const range = String(request.headers.range || "").match(/^bytes=(\d+)-$/);
    requestedOffset = range ? Number(range[1]) : 0;
    const payload = content.subarray(requestedOffset);
    response.writeHead(206, {
      "accept-ranges": "bytes",
      "content-length": payload.length,
      "content-range": `bytes ${requestedOffset}-${content.length - 1}/${content.length}`
    });
    response.end(payload);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const Updater = loadUpdater(userData);
    const updater = new Updater({
      downloadDir: updates,
      statePath: path.join(updates, "update-state.json"),
      executablePath: path.join(root, "BaiqiuAI.exe"),
      userDataPath: userData,
      processId: 0
    });
    const progress = [];
    const output = await updater.downloadUpdate(`http://127.0.0.1:${address.port}/client.zip`, checksum, (value) => progress.push(value), 0, content.length);
    assert.equal(requestedOffset, partialLength);
    assert.deepEqual(fs.readFileSync(output), content);
    assert.equal(fs.existsSync(path.join(updates, "update.zip.part")), false);
    assert.equal(progress.at(-1), 100);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
