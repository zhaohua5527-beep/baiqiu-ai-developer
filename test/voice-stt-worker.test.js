"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { VoiceSttWorker } = require("../services/voice-stt-worker");

function createFakeWorker() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-voice-worker-test-"));
  const scriptPath = path.join(root, "worker.js");
  fs.writeFileSync(scriptPath, [
    'const fs = require("node:fs");',
    'const readline = require("node:readline");',
    'let count = 0;',
    'const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);',
    'emit({ type: "ready" });',
    'readline.createInterface({ input: process.stdin }).on("line", (line) => {',
    '  const request = JSON.parse(line);',
    '  const marker = `${request.audioPath}.worker-restarted`;',
    '  if (request.audioPath.includes("crash-once") && !fs.existsSync(marker)) {',
    '    fs.writeFileSync(marker, "1");',
    '    process.exit(23);',
    '  }',
    '  count += 1;',
    '  emit({ type: "result", id: request.id, result: { success: true, transcript: "ok", pid: process.pid, count } });',
    '});'
  ].join("\n"), "utf8");
  return { root, scriptPath };
}

test("voice STT keeps one worker alive across consecutive transcriptions", async () => {
  const fixture = createFakeWorker();
  const worker = new VoiceSttWorker({ scriptPath: fixture.scriptPath, readyTimeoutMs: 5000, requestTimeoutMs: 5000 });
  const runtime = { pythonPath: process.execPath, agentRoot: fixture.root, fingerprint: "same-config" };
  try {
    const first = await worker.transcribe(path.join(fixture.root, "first.wav"), runtime);
    const second = await worker.transcribe(path.join(fixture.root, "second.wav"), runtime);
    assert.equal(first.pid, second.pid);
    assert.equal(first.count, 1);
    assert.equal(second.count, 2);
  } finally {
    await worker.stop();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("voice STT restarts once and retries when its worker exits", async () => {
  const fixture = createFakeWorker();
  const worker = new VoiceSttWorker({ scriptPath: fixture.scriptPath, readyTimeoutMs: 5000, requestTimeoutMs: 5000 });
  const runtime = { pythonPath: process.execPath, agentRoot: fixture.root, fingerprint: "restart-config" };
  const audioPath = path.join(fixture.root, "crash-once.wav");
  try {
    const result = await worker.transcribe(audioPath, runtime);
    assert.equal(result.success, true);
    assert.equal(result.transcript, "ok");
    assert.equal(result.count, 1);
    assert.equal(fs.existsSync(`${audioPath}.worker-restarted`), true);
  } finally {
    await worker.stop();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
