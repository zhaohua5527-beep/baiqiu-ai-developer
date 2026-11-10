"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const marker = "TASK_FACE_RESULT:";
const root = path.join(__dirname, "..");

if (process.argv.includes("--face-fixture")) {
  const { app, BrowserWindow } = require("electron");
  const directory = process.argv[process.argv.indexOf("--face-fixture") + 1];
  app.setPath("userData", path.join(directory, "profile"));
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, width: 800, height: 400, webPreferences: { backgroundThrottling: false } });
    const fixture = path.join(directory, "fixture.html");
    fs.writeFileSync(fixture, `<base href="${pathToFileURL(path.join(root, "renderer-v2") + path.sep).href}"><main id="faces" style="height:300px;overflow:auto"></main>`);
    await window.loadFile(fixture);
    await window.webContents.insertCSS(fs.readFileSync(path.join(root, "renderer-v2/styles.css"), "utf8"));
    await window.webContents.executeJavaScript(fs.readFileSync(path.join(root, "renderer-v2/task-face.js"), "utf8"));
    const source = fs.readFileSync(path.join(root, "renderer-v2/app.js"), "utf8");
    const phase = source.slice(source.indexOf("function showLiveExecutionPhase("), source.indexOf("function retireLiveExecutionPhase("));
    const result = await window.webContents.executeJavaScript(`(async () => {
      Object.defineProperty(document, 'hidden', { configurable:true, value:false });
      const container = document.querySelector('#faces');
      const makeRow = lifecycle => {
        const row = document.createElement('div');
        row.className = 'streaming-activity'; row.dataset.lifecycle = lifecycle;
        row.innerHTML = '<div class="execution-activity-head"><button class="execution-activity-toggle">' + BaiqiuTaskFace.markup() + '</button><span>执行任务</span></div>';
        container.appendChild(row); return row;
      };
      const history = makeRow('completed');
      const current = makeRow('running');
      const controller = BaiqiuTaskFace.create(container);
      const image = current.querySelector('.execution-short-task-features');
      const body = current.querySelector('.execution-short-task-body');
      const originalBody = body.getAttribute('src');
      const frames = [];
      const observer = new MutationObserver(records => records.forEach(record => {
        if(record.target === image) frames.push(image.getAttribute('src'));
      }));
      observer.observe(current, {subtree:true,attributes:true,attributeFilter:['src']});
      const placeLiveActivityBeforeBlock = () => {};
      ${phase}
      const entry = {activity:current, row:current};
      showLiveExecutionPhase(entry);
      controller.progress(current, {type:'tool_started',status:'running',turnId:'turn-live',eventId:'event-1',sequence:1});
      const refresh = setInterval(() => showLiveExecutionPhase(entry), 100);
      await new Promise(resolve => setTimeout(resolve, 3200));
      clearInterval(refresh);
      const running = { lifecycle:current.dataset.lifecycle, frames:[...new Set(frames)],
        animating:current.querySelector('.execution-short-task-face').dataset.animating,
        historyAnimating:history.querySelector('.execution-short-task-face').dataset.animating || '0',
        bodyUnchanged:body.getAttribute('src') === originalBody };
      frames.length = 0;
      current.dataset.lifecycle = 'completed';
      controller.complete(current, 'success', Date.now(), 'turn-live');
      await new Promise(resolve => setTimeout(resolve, 2700));
      const completed = {frames:[...new Set(frames)],active:[...container.querySelectorAll('[data-animating="1"]')].length};
      controller.destroy(); observer.disconnect();
      return {running, completed};
    })()`);
    process.stdout.write(marker + JSON.stringify(result) + "\n", () => app.exit());
  }).catch(error => { console.error(error); app.exit(1); });
} else {
  const { spawn } = require("node:child_process");
  const test = require("node:test");
  const assert = require("node:assert/strict");
  test("live phase refresh preserves blinking; only the latest face animates after completion", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-face-test-"));
    try {
      const result = await new Promise((resolve, reject) => {
        const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
        const child = spawn(require("electron"), [__filename, "--face-fixture", directory], { env, windowsHide:true });
        let stdout = "", stderr = "";
        const timer = setTimeout(() => { child.kill(); reject(new Error("face fixture timed out")); }, 20000);
        child.stdout.on("data", data => { stdout += data; });
        child.stderr.on("data", data => { stderr += data; });
        child.on("error", error => { clearTimeout(timer); reject(error); });
        child.on("exit", code => {
          clearTimeout(timer);
          if (code || !stdout.includes(marker)) return reject(new Error(stderr || stdout));
          resolve(JSON.parse(stdout.split(marker).at(-1)));
        });
      });
      assert.equal(result.running.lifecycle, "running");
      assert.equal(result.running.animating, "1");
      assert.equal(result.running.historyAnimating, "0");
      assert.equal(result.running.bodyUnchanged, true);
      assert.ok(result.running.frames.some(frame => frame.endsWith('focused.png')), JSON.stringify(result));
      assert.ok(result.running.frames.some(frame => frame.endsWith('focused-closed.png')), JSON.stringify(result));
      assert.ok(result.completed.frames.some(frame => frame.endsWith('neutral-closed.png')), JSON.stringify(result));
      assert.equal(result.completed.active, 1);
    } finally {
      fs.rmSync(directory, { recursive:true, force:true });
    }
  });
}
