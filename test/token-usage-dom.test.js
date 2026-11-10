"use strict";
const fs = require("node:fs");
const path = require("node:path");
const marker = "TOKEN_DOM:";
const root = path.join(__dirname, "..");
if (process.argv.includes("--token-dom")) {
  const { app, BrowserWindow } = require("electron");
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, width: 820, height: 200, webPreferences: { backgroundThrottling: false } });
    await window.loadURL("data:text/html,<main></main>");
    await window.webContents.executeJavaScript(fs.readFileSync(path.join(root, "renderer-v2/token-usage.js"), "utf8"));
    const css = fs.readFileSync(path.join(root, "renderer-v2/styles.css"), "utf8");
    const result = await window.webContents.executeJavaScript(`(async () => {
      const style = document.createElement('style'); style.textContent = ${JSON.stringify(css)}; document.head.appendChild(style);
      document.body.innerHTML = '<div class="message-list" style="padding:30px;background:white;--muted:#667085"><div class="streaming-activity" id="fixture"><div class="execution-activity-head"><button class="execution-activity-toggle"><span class="execution-short-task-face"></span></button><span class="execution-activity-inline-theater" data-theater-visible="1">黑球翻开笔记，继续整理下一页。</span><div class="message-knowledge-references execution-activity-head-references"><span>参考知识</span><button>门店商品 目前门店需要处理的资料</button></div><span class="streaming-elapsed">30s</span></div></div></div>';
      const root = document.getElementById('fixture');
      const usage = total => ({ source:'provider', inputTokens:0, outputTokens:total, totalTokens:total });
      let now = 0, nextTimer = 0;
      const timers = new Map();
      Object.defineProperty(performance, 'now', { value: () => now });
      window.setTimeout = callback => { timers.set(++nextTimer, callback); return nextTimer; };
      window.clearTimeout = id => timers.delete(id);
      const advance = milliseconds => {
        now += milliseconds;
        const pending = [...timers.values()]; timers.clear();
        pending.forEach(callback => callback());
      };
      BaiqiuTokenUsage.paint(root, null);
      const unknown = root.querySelector('.execution-token-value').textContent;
      BaiqiuTokenUsage.paint(root, usage(0), false);
      const width = root.querySelector('.execution-token-counter').getBoundingClientRect().width;
      BaiqiuTokenUsage.paint(root, usage(5));
      const value = root.querySelector('.execution-token-value');
      const samples = [];
      for (let index = 0; index < 5; index++) {
        advance(32); samples.push(value.textContent);
        BaiqiuTokenUsage.paint(root, usage(5));
      }
      const stoppedAtTarget = timers.size === 0;
      BaiqiuTokenUsage.paint(root, usage(1000));
      advance(160);
      const beforeRetarget = Number(value.textContent);
      BaiqiuTokenUsage.paint(root, usage(1500));
      advance(160);
      const afterRetarget = Number(value.textContent);
      advance(600);
      const badge = root.querySelector('.execution-token-usage');
      const elapsed = root.querySelector('.streaming-elapsed');
      const textRect = element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getBoundingClientRect();
      };
      const alignment = [];
      const baseline = element => {
        const marker = document.createElement('span');
        marker.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline';
        element.appendChild(marker);
        const position = marker.getBoundingClientRect().top;
        marker.remove();
        return position;
      };
      for (const completed of [false, true]) {
        root.classList.toggle('execution-activity-completed', completed);
        root.firstElementChild.classList.toggle('execution-completion-head', completed);
        root.querySelector('.execution-activity-inline-theater').style.display = completed ? 'none' : '';
        for (const scale of [0.9, 1, 1.5, 2]) {
          root.style.setProperty('--chat-font-scale', scale);
          for (const width of [320, 760]) {
            root.style.width = width + 'px';
            const timeRect = textRect(elapsed);
            const valueRect = textRect(value);
            const iconRect = badge.querySelector('.execution-token-icon').getBoundingClientRect();
            const badgeRect = badge.getBoundingClientRect();
            const textNodes = [elapsed, value, ...root.querySelectorAll('.message-knowledge-references > *')];
            if (!completed) textNodes.push(root.querySelector('.execution-activity-inline-theater'));
            const baselines = textNodes.map(baseline);
            const headRect = root.firstElementChild.getBoundingClientRect();
            const ballRect = root.querySelector('.execution-activity-toggle').getBoundingClientRect();
            alignment.push({completed, scale, width,
              baselineDelta: Math.max(...baselines) - Math.min(...baselines),
              ballCenterDelta: Math.abs(ballRect.top + ballRect.height / 2 - headRect.top - headRect.height / 2),
              topDelta: Math.abs(timeRect.top - valueRect.top),
              bottomDelta: Math.abs(timeRect.bottom - valueRect.bottom),
              iconCenterDelta: Math.abs(iconRect.top + iconRect.height / 2 - badgeRect.top - badgeRect.height / 2),
              afterTime: badgeRect.left >= elapsed.getBoundingClientRect().right});
          }
        }
      }
      root.classList.remove('execution-activity-completed');
      root.firstElementChild.classList.remove('execution-completion-head');
      root.style.removeProperty('--chat-font-scale');
      root.style.removeProperty('width');
      const afterTime = badge.getBoundingClientRect().left >= elapsed.getBoundingClientRect().right;
      BaiqiuTokenUsage.paint(root, usage(1500));
      const animations = badge.getAnimations({subtree:true}).length;
      const finalText = value.textContent;
      BaiqiuTokenUsage.paint(root, usage(2000));
      BaiqiuTokenUsage.paint(root, usage(2000), false);
      return {unknown, text:finalText, samples, stoppedAtTarget, beforeRetarget, afterRetarget,
        singleNode:root.querySelector('.execution-token-counter').childElementCount === 1,
        sameNode:value === root.querySelector('.execution-token-value'),
        settledWithoutTimer:value.textContent === '2k' && timers.size === 0,
        stableWidth:width===root.querySelector('.execution-token-counter').getBoundingClientRect().width,
        alignment, afterTime, animations, badges:root.querySelectorAll('.execution-token-usage').length,
        tooltip:badge.title};
    })()`);
    process.stdout.write(marker + JSON.stringify(result) + "\n", () => app.exit());
  }).catch(error => { console.error(error); app.exit(1); });
} else {
  const { spawn } = require("node:child_process");
  const test = require("node:test");
  const assert = require("node:assert/strict");
  test("counter replaces one number in place, counts forward, retargets and stops at actual usage", async () => {
    const result = await new Promise((resolve,reject) => {
      const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(require("electron"),[__filename,"--token-dom"],{env, windowsHide:true});
      let stdout="", stderr="";
      const timer=setTimeout(()=>{child.kill();reject(new Error("DOM timed out"));},15000);
      child.stdout.on("data",data=>{stdout+=data;}); child.stderr.on("data",data=>{stderr+=data;});
      child.on("error",reject);
      child.on("exit",code=>{clearTimeout(timer);if(code || !stdout.includes(marker))return reject(new Error(stderr||stdout));resolve(JSON.parse(stdout.split(marker).at(-1)));});
    });
    assert.equal(result.unknown,"—");
    assert.equal(result.text,"1.5k");
    assert.deepEqual(result.samples,["1","2","3","4","5"]);
    assert.equal(result.stoppedAtTarget,true);
    assert.ok(result.afterRetarget > result.beforeRetarget && result.afterRetarget < 1500);
    assert.equal(result.singleNode,true);
    assert.equal(result.sameNode,true);
    assert.equal(result.settledWithoutTimer,true);
    assert.equal(result.stableWidth,true);
    for (const sample of result.alignment) {
      assert.ok(sample.topDelta <= 1 && sample.bottomDelta <= 1 && sample.iconCenterDelta <= 1 && sample.baselineDelta <= 1 && sample.ballCenterDelta <= 1 && sample.afterTime, JSON.stringify(sample));
    }
    assert.equal(result.afterTime,true);
    assert.equal(result.animations,0);
    assert.equal(result.badges,1);
    assert.match(result.tooltip,/0.*2,000.*2,000/);
  });
}
