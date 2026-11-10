"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.join(__dirname, "..");

if (process.argv.includes("--rendered-code-copy-dom")) {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-rendered-code-copy-")));
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, width: 900, height: 600 });
    await window.loadURL("about:blank");
    await window.webContents.insertCSS(fs.readFileSync(path.join(root, "renderer-v2/styles.css"), "utf8"));
    const source = fs.readFileSync(path.join(root, "renderer-v2/app.js"), "utf8");
    const start = source.indexOf("function enhanceRenderedCodeBlocks");
    const end = source.indexOf("function enhanceHiddenCodeBlocks", start);
    const functionSource = JSON.stringify(source.slice(start, end));
    const result = await window.webContents.executeJavaScript(`(async () => {
      const api = { copyText: async value => { window.__copiedCode = value; } };
      const showCopyToast = () => {};
      eval(${functionSource});
      document.body.innerHTML = '<div class="rendered" id="rendered"><pre><code>第一行\\n第二行</code></pre></div>';
      const rendered = document.querySelector('#rendered');
      enhanceRenderedCodeBlocks(rendered);
      const card = rendered.querySelector('.rendered-code-card');
      const copy = rendered.querySelector('.rendered-code-copy');
      if (!card || !copy || rendered.querySelectorAll('.rendered-code-copy').length !== 1) throw new Error('代码卡片复制按钮未创建');
      if (getComputedStyle(copy).opacity !== '0') throw new Error('复制按钮默认没有隐藏');
      enhanceRenderedCodeBlocks(rendered);
      if (rendered.querySelectorAll('.rendered-code-copy').length !== 1) throw new Error('重复绑定复制按钮');
      copy.click();
      await new Promise(resolve => setTimeout(resolve, 0));
      if (window.__copiedCode !== '第一行\\n第二行') throw new Error('复制内容不完整');
      return { hidden: true, copied: true, idempotent: true };
    })()`);
    console.log("RENDERED_CODE_COPY_DOM=" + JSON.stringify(result));
    window.destroy();
    app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
} else {
  test("standalone rendered code card has one hidden copy control", () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const run = spawnSync(require("electron"), [__filename, "--rendered-code-copy-dom"], {
      cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 15000
    });
    assert.equal(run.status, 0, run.error?.message || run.stderr || run.stdout);
    assert.match(run.stdout, /RENDERED_CODE_COPY_DOM=.*"copied":true/);
  });
}
