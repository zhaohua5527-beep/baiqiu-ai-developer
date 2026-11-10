"use strict";

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2] || path.join(__dirname, "..");
const output = process.argv[3] || path.join(require("node:os").tmpdir(), "baiqiu-content-card.png");
app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "baiqiu-card-qa-")));

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1100, height: 780,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, offscreen: true } });
  try {
    const rendererRoot = process.env.BAIQIU_CARD_BASELINE || path.join(root, "renderer-v2");
    const source = fs.readFileSync(path.join(rendererRoot, "app.js"), "utf8");
    const between = (start, end) => {
      const from = source.indexOf(start);
      const to = source.indexOf(end, from + start.length);
      if (from < 0 || to < 0) throw new Error("Missing function: " + start);
      return source.slice(from, to);
    };
    await window.loadURL("about:blank");
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    await window.webContents.insertCSS(fs.readFileSync(path.join(rendererRoot, "styles.css"), "utf8"));
    await window.webContents.insertCSS(".hidden-code-icon { transition: none !important; }");
    const result = await window.webContents.executeJavaScript(`(async () => {
      const assert = require('node:assert/strict');
      window.marked = require(${JSON.stringify(path.join(root, "node_modules/marked/lib/marked.cjs"))});
      window.BaiqiuAssistantCodeUtils = require(${JSON.stringify(path.join(root, "services/assistant-code-utils.js"))});
      let copied = null;
      const transmitted = [];
      let receipt = { accepted: true, status: 'applied' };
      const api = { copyText: async text => { copied = text; }, supplementChat: async payload => {
        transmitted.push(payload); return receipt;
      } };
      const SessionTaskQueue = require(${JSON.stringify(path.join(root, "renderer-v2/session-task-queue.js"))});
      const sessionTaskQueue = new SessionTaskQueue();
      const state = { selectedSessionId: 'session-a', db: {sessions:[{id:'session-a'}, {id:'session-b'}]}, abortRequestedSessions: new Set() };
      const activeSendOwners = new Map();
      const queueDispatches = new Set();
      const activeLiveChatStreamForSession = () => null;
      const activeAssistantTypingForSession = () => null;
      const sessionIsRunning = session => activeSendOwners.has(session.id);
      const isWechatChatSession = () => false;
      const renderQueue = () => {};
      const showCopyToast = () => {};
      const rememberAuthoritativeMessage = () => {};
      const messageRowForId = () => true;
      const continuations = [];
      const sendCurrentTask = async (task, sessionId, options) => {
        continuations.push({task, sessionId}); options.onAccepted();
      };
      const bindRenderedLinks = () => {};
      const classifyRenderedDataLayout = () => {};
      const setAnswerResultDocument = () => {};
      const decorateAnswerResult = () => {};
      ${between("function escapeHtml", "function blackBallBrandText")}
      ${between("let assistantMarkdownRenderer", "function createAnswerResultDocument")}
      ${between("function hiddenCodeLanguageLabel", "function selectedSession")}
      ${between("function progressiveMarkdownStableBoundary", "function softenProgressiveTail")}
      ${between("async function sendLiveSupplement", "attachBtn.addEventListener")}
      if (${process.argv.includes("--benchmark")}) {
        const rendered = document.createElement('div'); rendered.className = 'rendered'; document.body.append(rendered);
        const source = '~~~log\\n' + 'OK value <tag> & data\\n'.repeat(2000);
        renderProgressiveMarkdown(rendered, source);
        let previous = rendered.querySelector('.hidden-code-card');
        let replacements = 0;
        const started = performance.now();
        for (let index=0; index<30; index++) {
          renderProgressiveMarkdown(rendered, source+'chunk '+index);
          const current = rendered.querySelector('.hidden-code-card');
          if (current !== previous) replacements++;
          previous = current;
        }
        return { benchmark:true, updates:30, characters:source.length, elapsedMs:Math.round(performance.now()-started), replacements };
      }
      document.body.style.cssText = 'display:block;padding:28px;overflow:auto;background:var(--surface);height:auto';
      document.documentElement.style.setProperty('--surface', '#ffffff');
      document.documentElement.style.setProperty('--text', '#172033');
      const sample = 'GET https://example.com/ → 200\\nServer: cloudflare\\n<html><body>404 Not Found</body></html>\\nOK DNS\\nFAIL content';
      const markdown = '### 官网核查记录\\n\\n~~~baiqiu-evidence\\n' + sample + '\\n~~~\\n\\n正文继续。';
      let checks = 0;
      for (const target of ['answer', 'structured']) {
        for (const mode of ['history', 'stream']) {
          const rendered = document.createElement('div');
          rendered.className = 'rendered';
          rendered.dataset.durable = '1';
          document.body.replaceChildren(rendered);
          if (mode === 'stream') {
            for (const length of [30, 90, markdown.length]) {
              renderProgressiveMarkdown(rendered, markdown.slice(0, length), { target });
            }
            assert.equal(rendered.querySelectorAll('.hidden-code-card').length, 1);
            const before = rendered.querySelector('.hidden-code-card').getBoundingClientRect();
            renderProgressiveMarkdown(rendered, markdown, { target, final: true });
            const after = rendered.querySelector('.hidden-code-card').getBoundingClientRect();
            assert.equal(before.height, after.height);
          } else if (target === 'structured') {
            renderStructuredEntryText(rendered, markdown, { final: true });
          } else {
            renderProgressiveMarkdown(rendered, markdown, { target, final: true });
          }
          const card = rendered.querySelector('.hidden-code-card');
          assert.ok(card);
          assert.equal(card.dataset.blockKind, 'evidence');
          assert.equal(card.querySelectorAll('[data-code-view], [data-code-preview], [data-code-toggle]').length, 0);
          assert.equal(card.querySelectorAll('.hidden-code-tools button').length, 3);
          assert.equal(card.querySelector('[data-code-edit]'), null);
          assert.equal(getComputedStyle(card.querySelector('.code-inline-actions')).visibility, 'hidden');
          assert.equal(getComputedStyle(card.querySelector('[data-code-content]')).backgroundColor, 'rgb(16, 18, 24)');
          assert.equal(card.querySelector('textarea').value, sample);
          assert.equal(card.querySelector('script, iframe'), null);
          assert.equal(card.querySelectorAll('pre code > span').length, sample.split('\\n').length);
          assert.equal(getComputedStyle(card.querySelector('[data-code-status="ok"]')).color, 'rgb(144, 215, 170)');
          const copy = card.querySelector('[data-code-copy]');
          assert.equal(getComputedStyle(copy).opacity, '0');
          copy.focus();
          await new Promise(resolve => setTimeout(resolve, 170));
          assert.equal(getComputedStyle(copy).opacity, '1', JSON.stringify({ active: document.activeElement?.outerHTML, focus: card.matches(':focus-within'), style: getComputedStyle(copy).cssText, width: copy.getBoundingClientRect().width, height: copy.getBoundingClientRect().height }));
          copy.click();
          await Promise.resolve();
          assert.ok(copied.includes('GET https://example.com/'));
          const codeText = card.querySelector('pre code').textContent;
          assert.equal(copied, codeText);
          assert.equal(codeText, sample);
          assert.equal(getComputedStyle(card.querySelector('pre')).borderTopWidth, '0px');
          assert.equal(card.querySelector('pre').hidden, false);
          for (const accent of ['#2563eb', '#4da3ff', '#3d8b65']) {
            document.documentElement.style.setProperty('--accent', accent);
            const probe = document.createElement('span');
            probe.style.color = accent;
            card.append(probe);
            assert.equal(getComputedStyle(card.querySelector('.hidden-code-language')).color, getComputedStyle(probe).color);
            probe.remove();
            checks++;
          }
          checks++;
        }
      }
      for (const language of ['javascript', 'json', 'text', 'log', 'diff', 'markdown', 'mermaid']) {
        const code = language === 'json' ? '{"count":2}' : 'original <tag> & value';
        const card = createRenderedCodeBlock({ language, code });
        document.body.append(card);
        card.querySelector('[data-code-copy]').click();
        await Promise.resolve();
        assert.equal(copied, code);
        assert.equal(card.querySelector('pre code').textContent, code);
        card.remove();
        checks++;
      }
      const revisionChecks = [];
      const settle = async () => { await new Promise(resolve => setTimeout(resolve, 20)); };
      const mount = (sessionId = 'session-a', turnId = 'turn-a', body = '~~~javascript\\nconst value = 1;\\n~~~\\n\\n正文') => {
        const row = document.createElement('div');
        row.className = 'message assistant';
        row.dataset.codeSessionId = sessionId;
        row.dataset.codeTurnId = turnId;
        const rendered = document.createElement('div');
        rendered.className = 'rendered result-region';
        const bubble = document.createElement('div'); bubble.className = 'bubble';
        bubble.append(rendered); row.append(bubble);
        document.body.replaceChildren(row);
        renderProgressiveMarkdown(rendered, body);
        return rendered;
      };
      let rendered = mount();
      let card = rendered.querySelector('.hidden-code-card');
      let editor = card.querySelector('textarea');
      assert.ok(editor);
      const beforeFocus = editor.getBoundingClientRect().toJSON();
      const beforeFocusStyle = getComputedStyle(editor);
      const typography = ['fontFamily','fontSize','lineHeight','paddingTop','paddingLeft','letterSpacing','tabSize'];
      const originalTypography = typography.map(name => beforeFocusStyle[name]);
      editor.focus();
      assert.deepEqual(editor.getBoundingClientRect().toJSON(), beforeFocus);
      assert.deepEqual(typography.map(name => getComputedStyle(editor)[name]), originalTypography);
      assert.deepEqual(typography.map(name => getComputedStyle(card.querySelector('pre'))[name]), originalTypography);
      assert.equal(getComputedStyle(editor).backgroundColor, 'rgba(0, 0, 0, 0)');
      assert.equal(getComputedStyle(card.querySelector('pre')).backgroundColor, 'rgb(16, 18, 24)');
      assert.equal(editor.getBoundingClientRect().height, 80);
      revisionChecks.push('direct-focus-preserves-geometry-font-and-dark-highlight-surface');
      editor.value = 'const value = "用户修改 <tag> & 值";';
      editor.dispatchEvent(new Event('input'));
      await settle();
      assert.deepEqual(editor.getBoundingClientRect().toJSON(), beforeFocus);
      assert.equal(card.querySelector('pre code').textContent, editor.value);
      card.querySelector('[data-code-copy]').click(); await settle();
      assert.equal(copied, editor.value);
      assert.equal(transmitted.length, 0);
      revisionChecks.push('copy-current-draft-and-blur-never-submit');
      editor.focus(); editor.setSelectionRange(6, 11); editor.dispatchEvent(new Event('select'));
      const position = editor.getBoundingClientRect();
      renderProgressiveMarkdown(rendered, '~~~javascript\\nconst value = 1;\\n~~~\\n\\n正文继续\\n\\n新段落');
      assert.equal(rendered.querySelector('textarea'), editor);
      assert.equal(document.activeElement, editor);
      assert.equal(editor.selectionStart, 6);
      assert.equal(editor.getBoundingClientRect().top, position.top);
      assert.equal(editor.getBoundingClientRect().left, position.left);
      revisionChecks.push('stream-keeps-editor-caret-position');
      mount('session-b', 'turn-b');
      await settle();
      assert.equal(document.querySelector('textarea').value, 'const value = 1;');
      rendered = mount(); await settle();
      editor = rendered.querySelector('textarea');
      assert.equal(editor.value, 'const value = "用户修改 <tag> & 值";');
      assert.equal(editor.selectionStart, 6);
      revisionChecks.push('session-isolation-and-draft-restoration');
      editor.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true }));
      assert.equal(transmitted.length, 0);
      const submit = rendered.querySelector('[data-code-edit-submit]');
      editor.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true}));
      submit.click(); assert.equal(transmitted.length, 0);
      editor.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true}));
      activeSendOwners.set('session-a', 'running-turn');
      submit.click(); submit.click(); await settle();
      assert.equal(transmitted.length, 1);
      const payload = JSON.parse(transmitted[0].text.slice(transmitted[0].text.indexOf('{')));
      assert.equal(payload.original, 'const value = 1;');
      assert.equal(payload.revised, 'const value = "用户修改 <tag> & 值";');
      assert.equal(payload.sessionId, 'session-a');
      assert.equal(payload.turnId, 'turn-a');
      assert.equal(transmitted[0].runId, 'running-turn');
      assert.equal(rendered.querySelector('pre code').textContent, 'const value = 1;');
      assert.equal(rendered.querySelector('textarea').value, 'const value = 1;');
      assert.equal(getComputedStyle(rendered.querySelector('.code-inline-actions')).visibility, 'hidden');
      revisionChecks.push('running-supplement-original-and-revised-exactly-once');
      const revisionMessage = {id:transmitted[0].supplementId, role:'user', text:transmitted[0].text};
      const savedMessage = JSON.stringify(revisionMessage);
      const revision = codeRevisionFromMessage(revisionMessage);
      assert.ok(revision);
      const revisionView = document.createElement('div'); revisionView.className = 'rendered';
      document.body.append(revisionView);
      renderCodeRevisionMessage(revisionView,revision);
      assert.equal(revisionView.querySelector('.code-revision-summary').textContent,'已提交内容修改，请按修改稿继续处理。');
      assert.equal(revisionView.querySelector('.code-revision-details').hidden,true);
      assert.equal(revisionView.querySelector('pre'),null);
      assert.ok(!revisionView.textContent.includes('revisionId'));
      const revisionToggle = revisionView.querySelector('button');
      const togglePosition = revisionToggle.getBoundingClientRect();
      revisionToggle.click();
      assert.equal(revisionToggle.getAttribute('aria-expanded'),'true');
      assert.equal(revisionView.querySelectorAll('pre')[0].textContent,revision.original);
      assert.equal(revisionView.querySelectorAll('pre')[1].textContent,revision.revised);
      assert.equal(revisionToggle.getBoundingClientRect().top,togglePosition.top);
      assert.equal(revisionToggle.getBoundingClientRect().left,togglePosition.left);
      assert.equal(revisionView.querySelector('.hidden-code-card'),null);
      revisionToggle.click();
      assert.equal(revisionView.querySelector('.code-revision-details').hidden,true);
      assert.equal(JSON.stringify(revisionMessage),savedMessage);
      for(const accent of ['#2563eb','#4da3ff','#3d8b65']) {
        document.documentElement.style.setProperty('--accent',accent);
        const probe=document.createElement('span'); probe.style.color=accent; revisionView.append(probe);
        assert.equal(getComputedStyle(revisionToggle).color,getComputedStyle(probe).color); probe.remove();
      }
      renderCodeRevisionMessage(revisionView,codeRevisionFromMessage(JSON.parse(savedMessage)));
      assert.equal(revisionView.querySelector('.code-revision-details').hidden,true);
      assert.equal(revisionView.querySelector('pre'),null);
      renderCodeRevisionMessage(revisionView,{...revision,instruction:'只调整配色，不改逻辑。',revised:''});
      assert.equal(revisionView.querySelector('.code-revision-summary').textContent,'只调整配色，不改逻辑。');
      revisionView.querySelector('button').click();
      assert.equal(revisionView.querySelectorAll('pre')[1].textContent,'（空内容）');
      assert.equal(codeRevisionFromMessage({...revisionMessage,role:'assistant'}),null);
      assert.ok(codeRevisionFromMessage({...revisionMessage,id:'generated-id-for-idle-continuation'}));
      assert.equal(codeRevisionFromMessage({...revisionMessage,text:'ordinary text '+revisionMessage.text}),null);
      assert.equal(codeRevisionFromMessage({...revisionMessage,text:revisionMessage.text.slice(0,-1)}),null);
      assert.equal(codeRevisionFromMessage({...revisionMessage,text:revisionMessage.text.replace('code_block_revision','other_operation')}),null);
      revisionView.remove();
      {
        const messageList = document.createElement('div');
        const requestRunFromMessage = () => null;
        const messageRenderFingerprint = message => JSON.stringify(message);
        const isNativeBlackBallMessage = () => false;
        const messageAssetsFromMessage = () => ({images:[],files:[]});
        ${between("function addMessage(", "function activityDetailText")}
        const host = document.createElement('div'); document.body.append(host);
        for (const id of [revisionMessage.id,'generated-id-for-idle-continuation']) {
          const row = addMessage({...revisionMessage,id},host,{animate:false,follow:false});
          assert.equal(row.querySelector('.code-revision-summary').textContent,'已提交内容修改，请按修改稿继续处理。');
          assert.equal(row.querySelector('.code-revision-details').hidden,true);
          assert.ok(!row.textContent.includes('revisionId'));
        }
        host.remove();
      }
      {
        const queuePanel = document.createElement('section');
        const queueList = document.createElement('div'); queuePanel.append(queueList); document.body.append(queuePanel);
        const selectedSession = () => state.db.sessions[0];
        const QUEUE_ROW_STATE_TITLES = {};
        const positionTaskBoard = () => {};
        const bindQueueLongPressSort = () => {};
        ${between("function editQueuedTaskInline", "function finishQueuedTaskEdit")}
        ${between("function renderQueue()", "function renderSettings")}
        sessionTaskQueue.pause('session-a');
        const task = sessionTaskQueue.enqueue('session-a',{id:revisionMessage.id,text:revisionMessage.text});
        renderQueue();
        const input = queueList.querySelector('textarea');
        assert.equal(input.value,'已提交内容修改，请按修改稿继续处理。');
        input.focus(); input.click();
        assert.equal(input.readOnly,true);
        assert.ok(!task.editing);
        assert.equal(task.text,revisionMessage.text);
        sessionTaskQueue.clear('session-a'); sessionTaskQueue.resume('session-a'); queuePanel.remove();
      }
      revisionChecks.push('compact-revision-theme-inline-toggle-history-roundtrip-and-payload-preservation');
      card = rendered.querySelector('.hidden-code-card');
      editor = card.querySelector('textarea');
      editor.value = '取消的内容'; editor.dispatchEvent(new Event('input'));
      card.querySelector('[data-code-edit-cancel]').click();
      assert.equal(card.querySelector('textarea').value, 'const value = 1;');
      revisionChecks.push('cancel-restores-original');
      activeSendOwners.clear();
      card.querySelector('textarea').value = '';
      card.querySelector('textarea').dispatchEvent(new Event('input'));
      card.querySelector('[data-code-edit-submit]').click(); await settle();
      assert.equal(continuations.length, 1);
      assert.equal(continuations[0].sessionId, 'session-a');
      const idle = JSON.parse(continuations[0].task.text.slice(continuations[0].task.text.indexOf('{')));
      assert.equal(idle.revised, '');
      revisionChecks.push('idle-continuation-and-intentional-empty-content');
      const editDraft = { id:'retry-edit', owner: {sessionId:'session-a', turnId:'turn-a'},
        language:'js', original:'A', value:'B', instruction:'' };
      for(let index=0; index<20; index++) sessionTaskQueue.enqueue('session-a', {text:'queued-'+index});
      card.querySelector('textarea').value = '队列满也要保留';
      card.querySelector('textarea').dispatchEvent(new Event('input'));
      card.querySelector('[data-code-edit-submit]').click();
      assert.equal(card.querySelector('textarea').value, '队列满也要保留');
      assert.match(card.querySelector('[role=status]').textContent, /已满/);
      card.querySelector('[data-code-edit-cancel]').click();
      sessionTaskQueue.clear('session-a');
      assert.throws(() => submitCodeBlockEdit({...editDraft, value:'x'.repeat(100001)}), /上限/);
      assert.equal(sessionTaskQueue.list('session-a').length, 0);
      revisionChecks.push('queue-full-and-oversize-preserve-draft');
      activeSendOwners.set('session-a','running-turn');
      receipt = {accepted:null, status:'unknown'};
      submitCodeBlockEdit(editDraft); await settle();
      const pending = sessionTaskQueue.list('session-a')[0];
      assert.ok(pending.receiptUnknown);
      clearTimeout(pending.retryTimer); pending.retryTimer = null;
      receipt = {accepted:true, status:'applied'};
      await processQueue('session-a');
      assert.equal(transmitted.at(-1).supplementId, transmitted.at(-2).supplementId);
      assert.equal(sessionTaskQueue.list('session-a').length,0);
      revisionChecks.push('unknown-receipt-preserved-and-idempotent-retry');
      receipt = {accepted:false, status:'unsupported'};
      submitCodeBlockEdit({...editDraft,id:'fallback-edit'}); await settle();
      assert.equal(sessionTaskQueue.list('session-a')[0].deliveryMode,'queue');
      activeSendOwners.clear(); await processQueue('session-a');
      assert.equal(continuations.at(-1).task.id,'fallback-edit');
      revisionChecks.push('unsupported-steer-continues-after-completion');
      const duplicated = mount('session-a','duplicate-turn','~~~js\\nsame\\n~~~\\n\\n~~~js\\nsame\\n~~~');
      assert.equal(duplicated.querySelectorAll('.hidden-code-card').length, 2);
      assert.ok(duplicated.querySelector('.progressive-markdown-stable .hidden-code-card'));
      assert.ok(duplicated.querySelector('.progressive-markdown-tail .hidden-code-card'));
      revisionChecks.push('identical-blocks-keep-independent-positions');
      const exact = '<strong>bold</strong>\\n<br>\\n<img src=x onerror=alert(1)>\\n  keep spaces  ';
      const fidelity = mount('session-a','fidelity-turn','~~~html\\n'+exact+'\\n~~~');
      assert.equal(fidelity.querySelector('pre code').textContent, exact);
      assert.equal(fidelity.querySelector('img'), null);
      fidelity.querySelector('[data-code-copy]').click(); await settle();
      assert.equal(copied, exact);
      revisionChecks.push('html-source-copy-edit-fidelity-without-execution');
      const scrollSource = ('OK C:\\\\资料\\\\完整路径.txt\\t' + 'long '.repeat(65) + '\\n').repeat(70);
      rendered = mount('session-a','scroll-turn','~~~log\\n'+scrollSource+'~~~'); await settle();
      editor = rendered.querySelector('textarea');
      const scrollPre = rendered.querySelector('pre');
      assert.equal(editor.clientWidth, scrollPre.clientWidth);
      assert.equal(editor.clientHeight, scrollPre.clientHeight);
      assert.ok(Math.abs(editor.scrollHeight-scrollPre.scrollHeight) < 2);
      assert.ok(Math.abs(editor.scrollWidth-scrollPre.scrollWidth) < 2);
      editor.focus(); editor.setSelectionRange(0,0);
      editor.scrollTop = 250; editor.scrollLeft = 160;
      editor.dispatchEvent(new Event('scroll'));
      assert.equal(scrollPre.scrollTop, editor.scrollTop);
      assert.equal(scrollPre.scrollLeft, editor.scrollLeft);
      editor.value += '\\n新行'; editor.dispatchEvent(new Event('input')); await settle();
      const savedHeight = rendered.querySelector('[data-code-content]').getBoundingClientRect().height;
      const savedScroll = [editor.scrollTop,editor.scrollLeft];
      mount('session-b'); await settle();
      rendered = mount('session-a','scroll-turn','~~~log\\n'+scrollSource+'~~~'); await settle();
      editor = rendered.querySelector('textarea');
      assert.ok(editor.value.endsWith('新行'));
      assert.deepEqual([editor.scrollTop,editor.scrollLeft], savedScroll);
      assert.equal(rendered.querySelector('[data-code-content]').getBoundingClientRect().height, savedHeight);
      revisionChecks.push('long-lines-tabs-chinese-scroll-alignment-and-restoration');
      activeSendOwners.set('session-a','ending-turn');
      receipt = {accepted:false,status:'not_running'};
      const supplementApi = api.supplementChat;
      api.supplementChat = async payload => { activeSendOwners.clear(); return supplementApi(payload); };
      submitCodeBlockEdit({...editDraft,id:'completion-race'}); await settle();
      assert.equal(continuations.at(-1).task.id,'completion-race');
      assert.equal(sessionTaskQueue.list('session-a').length,0);
      api.supplementChat = supplementApi;
      revisionChecks.push('completion-during-submission-falls-back-once');
      rendered = mount();
      state.selectedSessionId = 'session-b';
      rendered.querySelector('textarea').value = '始终提交到原会话';
      rendered.querySelector('textarea').dispatchEvent(new Event('input'));
      rendered.querySelector('[data-code-edit-submit]').click(); await settle();
      assert.equal(continuations.at(-1).sessionId,'session-a');
      state.selectedSessionId = 'session-a';
      revisionChecks.push('selection-change-cannot-redirect-submission');
      const performanceView = mount('session-a','performance-turn','~~~log\\nstarting');
      const streamCard = performanceView.querySelector('.hidden-code-card');
      assert.equal(streamCard.querySelector('textarea'), null);
      const longBlock = '~~~log\\n' + 'OK value <tag> & data\\n'.repeat(2000);
      const started = performance.now();
      for(let index=0; index<30; index++) renderProgressiveMarkdown(performanceView,longBlock+'chunk '+index);
      const elapsed = performance.now()-started;
      assert.equal(performanceView.querySelector('.hidden-code-card'), streamCard);
      renderProgressiveMarkdown(performanceView,longBlock+'done\\n~~~',{final:true});
      assert.ok(performanceView.querySelector('textarea'));
      assert.ok(performanceView.querySelector('pre code').textContent.includes('<tag> & data'));
      revisionChecks.push('large-open-fence-reuses-one-card');
      const sampleView = document.createElement('div');
      sampleView.className = 'rendered';
      document.body.replaceChildren(sampleView);
      document.documentElement.style.setProperty('--accent', '#2563eb');
      renderProgressiveMarkdown(sampleView, markdown, { target: 'structured', final: true });
      const sampleRow = document.createElement('div');
      sampleRow.className = 'message assistant';
      sampleRow.dataset.codeSessionId = 'session-a';
      sampleRow.dataset.codeTurnId = 'preview-turn';
      sampleView.replaceWith(sampleRow);
      const sampleBubble = document.createElement('div'); sampleBubble.className = 'bubble';
      sampleBubble.append(sampleView); sampleRow.append(sampleBubble);
      const previewEditor = sampleView.querySelector('textarea');
      previewEditor.focus();
      previewEditor.value += '\\nPASS 已改为中文提示，等待确认';
      previewEditor.dispatchEvent(new Event('input'));
      if (${process.argv.includes("--revision-preview")}) {
        document.body.replaceChildren();
        for (const expanded of [false,true]) {
          const preview = document.createElement('div');
          preview.className = 'rendered';
          preview.style.cssText = 'width:700px;max-width:100%;margin:24px auto 48px';
          document.body.append(preview);
          renderCodeRevisionMessage(preview,{...revision,instruction:'请把提示文字改成中文，保留其他逻辑。'});
          if (expanded) preview.querySelector('button').click();
        }
      }
      await new Promise(resolve => setTimeout(resolve, 170));
      return { checks, revisionChecks, transportSample:transmitted[0], streamBenchmark: {updates:30, characters:longBlock.length, elapsedMs:Math.round(elapsed)}, cards: sampleView.querySelectorAll('.hidden-code-card').length };
    })()`);
    if (!result.benchmark && !process.argv.includes('--revision-preview')) {
      const beforeNativeInput = await window.webContents.executeJavaScript(`(() => {
        const editor = document.querySelector('.code-inline-input');
        editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length);
        return editor.value;
      })()`);
      window.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});
      window.webContents.sendInputEvent({type:'char',keyCode:'\r'});
      window.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
      await new Promise(resolve => setTimeout(resolve, 50));
      await window.webContents.insertText('确认前仅保存草稿');
      await new Promise(resolve => setTimeout(resolve, 50));
      const nativeInput = await window.webContents.executeJavaScript(`(() => {
        const editor = document.querySelector('.code-inline-input');
        return { value:editor.value, highlighted:document.querySelector('.code-inline-surface code').textContent,
          focused:document.activeElement === editor };
      })()`);
      require('node:assert/strict').equal(nativeInput.value, beforeNativeInput + '\n确认前仅保存草稿');
      require('node:assert/strict').equal(nativeInput.highlighted, nativeInput.value);
      require('node:assert/strict').equal(nativeInput.focused, true);
      result.revisionChecks.push('native-enter-inserts-newline-and-native-text-input-keeps-highlighting');
    }
    if (result.transportSample) {
      fs.writeFileSync(output + '.request.json', JSON.stringify(result.transportSample, null, 2), 'utf8');
      delete result.transportSample;
    }
    window.webContents.invalidate();
    await new Promise(resolve => setTimeout(resolve, 250));
    fs.writeFileSync(output, (await window.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({ ok: true, ...result, screenshot: output, root }));
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error.stack || String(error));
    window.destroy();
    app.exit(1);
  }
});
