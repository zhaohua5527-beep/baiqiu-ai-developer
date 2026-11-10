"use strict";

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "baiqiu-evidence-")));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { nodeIntegration: true, contextIsolation: false } });
  try {
    const source = fs.readFileSync(path.join(root, "renderer-v2/app.js"), "utf8");
    const between = (start, end) => {
      const from = source.indexOf(start);
      const to = source.indexOf(end, from + start.length);
      if (from < 0 || to < 0) throw new Error("Renderer function missing: " + start);
      return source.slice(from, to);
    };
    await window.loadURL("about:blank");
    await window.webContents.insertCSS(fs.readFileSync(path.join(root, "renderer-v2/styles.css"), "utf8"));
    const result = await window.webContents.executeJavaScript(`(() => {
      try {
      const assert = require('node:assert/strict');
      window.marked = require(${JSON.stringify(require.resolve("marked", { paths: [root, process.env.BAIQIU_TEST_DEPENDENCIES || root] }))});
      window.BaiqiuAssistantCodeUtils = require(${JSON.stringify(path.join(root, "services/assistant-code-utils.js"))});
      window.BaiqiuResultAst = require(${JSON.stringify(path.join(root, "services/result-ast.js"))});
      const bindRenderedLinks = () => {}, classifyRenderedDataLayout = () => {};
      ${between("function escapeHtml", "function filterLiveAssistantDelta")}
      ${between("function progressiveMarkdownStableBoundary", "function softenProgressiveTail")}
      const prefix = '关键文件齐全。\\n\\n~~~baiqiu-evidence\\nOK tools/git.exe';
      const source = prefix + '\\nMISS optional/bash.exe\\n~~~\\n\\n网络仍失败，需要重试。\\n\\n~~~js\\nconst value = 1;\\n~~~';
      const rendered = document.createElement('div');
      rendered.className = 'rendered';
      document.body.append(rendered);
      renderProgressiveMarkdown(rendered, prefix);
      let details = rendered.querySelector('details.answer-evidence');
      assert.ok(details && !details.open);
      const closedHeight = details.getBoundingClientRect().height;
      details.querySelector('summary').click();
      assert.equal(details.open, true);
      assert.ok(details.getBoundingClientRect().height > closedHeight);
      renderProgressiveMarkdown(rendered, prefix + '\\nOK second');
      assert.equal(rendered.querySelector('details.answer-evidence').open, true);
      renderProgressiveMarkdown(rendered, source);
      assert.equal(rendered.querySelector('details.answer-evidence').open, true);
      renderProgressiveMarkdown(rendered, source, {final:true});
      assert.equal(rendered.querySelector('details.answer-evidence').open, true);
      assert.equal(rendered.querySelectorAll('details').length, 1);
      assert.ok([...rendered.querySelectorAll('p')].some(node => node.textContent.includes('网络仍失败') && !node.closest('details')));
      assert.ok(!rendered.querySelector('code.language-js').closest('details'));
      const headingRendered = document.createElement('div');
      headingRendered.innerHTML = renderMarkdown('## 页文件实测\\n\\n~~~baiqiu-evidence\\nOK verified\\nMISS optional\\n~~~');
      const headingEvidence = headingRendered.querySelector('.answer-with-evidence > h2 + details');
      assert.ok(headingEvidence);
      const summary = headingEvidence.querySelector('summary');
      assert.equal(getComputedStyle(headingEvidence.parentElement).display, 'inline');
      assert.equal(getComputedStyle(headingEvidence).display, 'inline');
      const closedTop = summary.getBoundingClientRect().top;
      summary.click();
      const openTop = summary.getBoundingClientRect().top;
      assert.ok(Math.abs(openTop - closedTop) < 1, `expand moved summary: ${closedTop} -> ${openTop}`);
      const inlineRendered = document.createElement('div');
      inlineRendered.className = 'rendered';
      inlineRendered.innerHTML = renderMarkdown('补充说明。\n\n~~~baiqiu-evidence\nOK\n~~~');
      document.body.append(inlineRendered);
      const inlineDetails = inlineRendered.querySelector('details.answer-evidence');
      assert.equal(inlineDetails.getBoundingClientRect().top,
        inlineDetails.previousElementSibling.getBoundingClientRect().top);
      assert.equal(answerResultCopyText(rendered, source), source);
      const history = document.createElement('div');
      history.innerHTML = renderMarkdown(JSON.parse(JSON.stringify({text:source})).text);
      assert.equal(history.querySelector('details').open, false);
      assert.match(history.querySelector('details pre').textContent, /MISS optional/);
      const structured = document.createElement('div');
      structured.dataset.durable = '1';
      renderStructuredEntryText(structured, source, {final:true});
      assert.equal(structured.querySelector('details').open, false);
      assert.equal(structured.querySelectorAll('details').length, 1);
      return { streaming:true, expansionPreserved:true, history:true, structured:true, copyPreserved:true };
      } catch (error) { return { error: error.stack }; }
    })()`);
    if (result.error) throw new Error(result.error);
    console.log(JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    console.error(error.stack);
    app.exit(1);
  }
});
