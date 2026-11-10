"use strict";

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const baseline = process.argv[2];
app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "baiqiu-answer-layout-")));

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { nodeIntegration: true, contextIsolation: false } });
  let exitCode = 0;
  try {
    const source = fs.readFileSync(baseline ? path.join(baseline, "app-before.js") : path.join(root, "renderer-v2/app.js"), "utf8");
    const between = (start, end) => {
      const from = source.indexOf(start);
      const to = source.indexOf(end, from + start.length);
      if (from < 0 || to < 0) throw new Error("Missing source: " + start);
      return source.slice(from, to);
    };
    const finalizer = between("function finalizeLiveChatStream", "function discardLiveChatStreamsForSession");
    const commit = finalizer.slice(finalizer.indexOf("    mutatePreservingMessageViewport(() => {"),
      finalizer.indexOf('    reportStartupMetric("cross-reply:renderer:finalize-dom"'));
    await window.loadURL("about:blank");
    await window.webContents.insertCSS(fs.readFileSync(baseline ? path.join(baseline, "styles-before.css") : path.join(root, "renderer-v2/styles.css"), "utf8"));
    const result = await window.webContents.executeJavaScript(`(() => {
      try {
      const assert = require('node:assert/strict');
      window.marked = require(${JSON.stringify(path.join(root, "node_modules/marked/lib/marked.cjs"))});
      window.BaiqiuAssistantCodeUtils = require(${JSON.stringify(path.join(root, "services/assistant-code-utils.js"))});
      window.BaiqiuResultAst = require(${JSON.stringify(path.join(root, "services/result-ast.js"))});
      const persistedReplay = require(${JSON.stringify(path.join(root, "renderer-v2/persisted-replay.js"))});
      const promoteNovelChapterHeadings = text => text;
      const bindRenderedLinks = () => {};
      const filterAssistantExecutionOutput = text => text;
      const mutatePreservingMessageViewport = callback => callback();
      const flushLiveActivityPaint = () => {};
      const collapseCompletedExecutionActivity = () => null;
      const syncExecutionReplyTimeline = () => {};
      const createMessageKnowledgeReferences = () => null;
      const ensureAssistantCopyAction = () => {};
      const evaluateLongReply = () => {};
      const ensureProtocolContinueAction = () => {};
      const publicExecutionDetailsFromMessage = () => [];
      const replaceExecutionActivityLines = () => {};
      const isPrimaryExecutionSummaryEvent = () => false;
      const isPublicStructuredThought = () => false;
      const isDurableStructuredEvent = () => true;
      const softenProgressiveTail = () => {};
      const completeLiveReasoningSegment = () => {};
      const liveAnswerSegmentIsVisible = () => true;
      const flushQueuedReasoning = () => {};
      const ensureLiveSegmentBlock = (entry, id) => entry.segmentBlocks.get(id);
      ${between("function escapeHtml", "function extractClientCodeBlocks")}
      ${between("function progressiveMarkdownStableBoundary", "function softenProgressiveTail")}
      ${between("function progressiveSourceUsesWideLayout", "function messageAssetIdentity")}
      ${between("function renderSegmentedLiveAnswer", "function revealLiveChatStreamText")}
      ${between("function answerSegmentsFromMessage", "function snapshotMessageIdentity")}
      const commitAnswer = (entry, message, options = {}) => {
        const rendered = entry.rendered, currentRow = entry.row;
        const finalDisplayText = entry.text, streamedDisplayText = entry.text;
        const hasStreamedAnswer = true, finalExtendsStream = options.extends === true;
        const durableStructuredEvents = message.structuredEvents;
        const completedDurationMs = 1000, responseMessageId = 'fixture-result';
        ${commit}
      };
      const geometry = node => {
        const style = getComputedStyle(node), rect = node.getBoundingClientRect();
        return { width: rect.width, height: rect.height, font: style.fontFamily,
          size: style.fontSize, lineHeight: style.lineHeight, weight: style.fontWeight };
      };
      const cases = [
        '普通正文。'.repeat(50),
        '# 标题\\n\\n**重点**与普通正文。\\n\\n- 第一项\\n- 第二项\\n\\n最后一段。',
        '## 数据\\n\\n| 项目 | 数量 |\\n| --- | ---: |\\n| A | 12 |\\n\\n~~~js\\nconsole.log(1);\\n~~~'
      ];
      let checks = 0;
      for (const width of [480, 1000]) for (const scale of [1, 1.25]) for (const text of cases) {
        document.body.innerHTML = '<div class="message-list"><div class="message assistant streaming-response"><div class="bubble"><div class="rendered result-region streaming-rendered"></div></div></div></div>';
        const list = document.querySelector('.message-list');
        list.style.width = width + 'px';
        list.style.setProperty('--chat-font-scale', String(scale));
        const row = list.querySelector('.message'), rendered = row.querySelector('.rendered');
        const block = document.createElement('section');
        block.className = 'stream-segment-block';
        const reply = document.createElement('div');
        reply.className = 'structured-result-entry'; reply.dataset.durable = '1';
        reply.textContent = '已经核实的阶段性结论。';
        const answer = document.createElement('div'); answer.className = 'rendered stream-segment-answer';
        block.append(reply, answer); rendered.appendChild(block);
        renderProgressiveMarkdown(answer, text);
        const contentNode = answer.querySelector('p, h1, h2, table');
        const snapshot = [geometry(answer), geometry(contentNode), geometry(reply)];
        const range = document.createRange(); range.selectNodeContents(contentNode);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        const selected = selection.toString();
        const observer = new MutationObserver(() => {});
        observer.observe(rendered, { subtree: true, childList: true });
        const event = { eventId: 'stage', turnId: 'fixture', sequence: 1, segmentId: 'answer',
          target: 'structured', semanticType: 'stage_result', message: reply.textContent };
        const entry = { row, rendered, text, visibleText: text, revealedLength: Array.from(text).length,
          targetChars: Array.from(text), activityDetails: [], structuredEvents: [event],
          segmentBlocks: new Map([['answer', { answer }]]) };
        const message = { text, structuredEvents: [event], answerSegments: [{ eventId: 'answer',
          sequence: 2, segmentId: 'answer', target: 'answer', text }] };
        commitAnswer(entry, message);
        assert.equal(answer.isConnected, true, 'Completion replaced the answer');
        assert.equal(reply.isConnected, true, 'Completion replaced the stage reply');
        assert.equal(selection.toString(), selected, 'Completion lost the text selection');
        assert.equal(observer.takeRecords().filter(record => record.removedNodes.length).length, 0);
        assert.deepEqual([geometry(answer), geometry(contentNode), geometry(reply)], snapshot,
          'Completion changed typography or wrapping');
        observer.disconnect();
        checks++;
      }
      let recovered = 0;
      for (const missing of [1, 8, 40, 1299]) {
        const text = '**完整回复**\\n\\n' + '真实正文。'.repeat(260) + '结尾😀。';
        document.body.innerHTML = '<div class="message assistant"><div class="bubble"><div class="rendered"></div></div></div>';
        const row = document.querySelector('.message'), rendered = row.querySelector('.rendered');
        const first = document.createElement('div'); first.className = 'stream-segment-answer';
        const answer = document.createElement('div'); answer.className = 'stream-segment-answer';
        const stage = document.createElement('div'); stage.textContent = '原有公开阶段结果';
        rendered.append(first, stage, answer);
        const prefix = '第一段已完成。\\n\\n';
        renderProgressiveMarkdown(first, prefix);
        const firstNode = first.firstChild;
        const chars = Array.from(text), partial = chars.slice(0, chars.length - missing);
        renderProgressiveMarkdown(answer, partial.join(''));
        const all = prefix + text, visible = prefix + partial.join('');
        const entry = { row, rendered, text: all, visibleText: visible, visibleChars: Array.from(visible),
          targetChars: Array.from(all), revealedLength: Array.from(visible).length, activityDetails: [], structuredEvents: [],
          segmentOrder: ['first', 'last'], segmentCharsById: new Map([['first', Array.from(prefix)], ['last', chars]]),
          segmentBlocks: new Map([['first', {answer: first, renderedVisibleCount: Array.from(prefix).length}],
            ['last', {answer, renderedVisibleCount: partial.length}]]) };
        commitAnswer(entry, {text: all, structuredEvents: []});
        const probe = document.createElement('div'); renderProgressiveMarkdown(probe, text);
        assert.equal(answer.textContent, probe.textContent, 'Completion lost received characters');
        assert.equal(entry.revealedLength, Array.from(all).length);
        assert.equal(first.firstChild, firstNode, 'Completed prefix was replayed');
        assert.equal(stage.isConnected, true, 'Stage result disappeared');
        recovered++;
      }
      return { checks, recovered, preservedNodes: true, typographyAndWrapping: 'stable' };
      } catch (error) { return { error: error.message, stack: error.stack }; }
    })()`);
    if (result.error) throw new Error(result.stack || result.error);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.stack);
    exitCode = 1;
  } finally {
    window.destroy();
    app.exit(exitCode);
  }
});
