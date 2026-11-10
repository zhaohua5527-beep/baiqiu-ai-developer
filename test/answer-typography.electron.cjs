"use strict";

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "baiqiu-typography-")));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1120, height: 900,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  try {
    const source = fs.readFileSync(path.join(root, "renderer-v2/app.js"), "utf8");
    const between = (start, end) => {
      const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
      if (from < 0 || to < 0) throw new Error("Missing renderer: " + start);
      return source.slice(from, to);
    };
    await window.loadURL("about:blank");
    await window.webContents.insertCSS(fs.readFileSync(path.join(root, "renderer-v2/styles.css"), "utf8"));
    const result = await window.webContents.executeJavaScript(`(() => {
      const assert = require('node:assert/strict');
      window.marked = require(${JSON.stringify(path.join(root, "node_modules/marked/lib/marked.cjs"))});
      window.BaiqiuAssistantCodeUtils = require(${JSON.stringify(path.join(root, "services/assistant-code-utils.js"))});
      window.BaiqiuResultAst = require(${JSON.stringify(path.join(root, "services/result-ast.js"))});
      const bindRenderedLinks = () => {}, classifyRenderedDataLayout = () => {};
      ${between("function escapeHtml", "function extractClientCodeBlocks")}
      ${between("function progressiveMarkdownStableBoundary", "function softenProgressiveTail")}
      const source = '## 需要补充的资料\\n\\n普通正文与**重点**使用相同字号。\\n\\n1. 超市是**个体工商户**还是**有限公司**？\\n\\n2. 是否**有书面协议**？\\n\\n3. 你要的是**钱**，还是**干净脱身**？\\n\\n把论点写到**"法律保留"**这一层。\\n\\n第一章 普通文本不自动放大\\n\\n> 引用原文\\n\\n| 项目 | 内容 |\\n| --- | --- |\\n| 状态 | 已核对 |\\n\\n~~~text\\n**代码不加粗**\\n~~~';
      let checks = 0;
      for (const width of [420, 900]) for (const scale of [0.85, 1, 1.5]) {
        document.body.innerHTML = '<main class="message-list"></main>';
        const list = document.querySelector('main');
        list.style.width = width + 'px'; list.style.setProperty('--chat-font-scale', scale);
        const snapshots = [];
        for (const mode of ['live', 'history', 'structured']) {
          const row = document.createElement('div'); row.className = 'message assistant';
          const bubble = document.createElement('div'); bubble.className = 'bubble';
          const node = document.createElement('div'); node.className = 'rendered result-region';
          bubble.append(node); row.append(bubble); list.append(row);
          if (mode === 'structured') {
            node.className = 'structured-result-entry'; node.dataset.durable = '1';
            renderStructuredEntryText(node, source);
            assert.equal(node._resultAst, undefined, 'Structured event became an answer');
          } else if (mode === 'live') {
            for (let length = 1; length <= source.length; length += 11) renderProgressiveMarkdown(node, source.slice(0, length));
            renderProgressiveMarkdown(node, source);
            const heading = node.querySelector('h2');
            renderProgressiveMarkdown(node, source, {final:true});
            assert.equal(node.querySelector('h2'), heading, 'Finalization rebuilt completed content');
          } else {
            node.classList.add('native-black-ball-text');
            node.innerHTML = renderMarkdown(source); decorateAnswerResult(node, source);
          }
          assert.equal(node.querySelectorAll('h1,h2,h3,h4,h5,h6').length, 1);
          assert.equal(node.querySelectorAll('ol').length, 1);
          assert.equal(node.querySelectorAll('li').length, 3);
          assert.equal(node.querySelectorAll('table').length, 1);
          assert.ok([...node.querySelectorAll('strong')].some(strong => strong.textContent === '"法律保留"'));
          assert.equal(node.querySelector('pre code').textContent.trim(), '**代码不加粗**');
          const textStyle = getComputedStyle(node.querySelector('li'));
          for (const strong of node.querySelectorAll('li strong')) {
            const style = getComputedStyle(strong);
            assert.equal(style.fontSize, textStyle.fontSize);
            assert.equal(style.fontFamily, textStyle.fontFamily);
            assert.equal(style.lineHeight, textStyle.lineHeight);
          }
          assert.equal(getComputedStyle(node).whiteSpace, 'normal');
          const items = [...node.querySelectorAll('li')];
          assert.ok(items[1].getBoundingClientRect().top - items[0].getBoundingClientRect().bottom < parseFloat(textStyle.fontSize));
          snapshots.push({size:textStyle.fontSize, family:textStyle.fontFamily, lineHeight:textStyle.lineHeight,
            listHeight:node.querySelector('ol').getBoundingClientRect().height,
            titleSize:getComputedStyle(node.querySelector('h2')).fontSize});
          checks++;
        }
        assert.deepEqual(snapshots[0], snapshots[1], 'Live/history typography differs');
        assert.deepEqual(snapshots[0], snapshots[2], 'Structured/body typography differs');
      }
      return {checks, modes:3, scales:3, widths:2, typography:'consistent', markdown:'semantic'};
    })()`);
    console.log(JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    console.error(error.stack);
    app.exit(1);
  }
});
