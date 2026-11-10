"use strict";

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-layout-")));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 900, height: 500 });
  try {
    await window.loadURL("data:text/html,<main></main>");
    await window.webContents.insertCSS(fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "styles.css"), "utf8"));
    const result = await window.webContents.executeJavaScript(`(() => {
      const rendered = document.createElement("div");
      rendered.className = "rendered";
      rendered.innerHTML = '<div class="answer-with-evidence"><p>补充说明。</p><details class="answer-evidence"><summary>展开</summary><pre><code>OK</code></pre></details></div>';
      document.body.append(rendered);
      const wrapper = rendered.querySelector(".answer-with-evidence");
      const details = rendered.querySelector("details");
      const summary = details.querySelector("summary");
      const before = summary.getBoundingClientRect().top;
      const paragraphTop = wrapper.querySelector("p").getBoundingClientRect().top;
      const display = [getComputedStyle(wrapper).display, getComputedStyle(details).display];
      summary.click();
      const after = summary.getBoundingClientRect().top;
      return { display, sameLine: before === paragraphTop, stable: Math.abs(after - before) < 1 };
    })()`);
    if (!result.sameLine || !result.stable || result.display.join(",") !== "inline,inline") {
      throw new Error(JSON.stringify(result));
    }
    console.log(JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    console.error(error.stack || error);
    app.exit(1);
  }
});
