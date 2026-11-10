"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const root = path.join(__dirname, "..");

if (process.argv.includes("--queue-dom")) {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-supplement-")));
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { backgroundThrottling: false } });
    await window.loadURL("about:blank");
    await window.webContents.insertCSS(fs.readFileSync(path.join(root, "renderer-v2/styles.css"), "utf8"));
    await window.webContents.executeJavaScript(fs.readFileSync(path.join(root, "renderer-v2/session-task-queue.js"), "utf8"));
    const source = fs.readFileSync(path.join(root, "renderer-v2/app.js"), "utf8");
    const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
    const result = await window.webContents.executeJavaScript(`(async () => {
      const check = (value, message) => { if (!value) throw new Error(message); };
      const sessionTaskQueue = new BaiqiuSessionTaskQueue();
      const session = {id:'one'};
      const selectedSession = () => session;
      const sessionIsRunning = () => true;
      const positionTaskBoard = () => {};
      const state = {};
      const presetTaskContextMenu = null;
      const showPresetTaskContextMenu = () => {};
      const sent = [];
      const showCopyToast = () => {};
      const processQueue = async () => {
        const confirmed = sessionTaskQueue.list(session.id).find(task => task.autoStart && !task.editing);
        if (confirmed) { sent.push({text:confirmed.text, mode:confirmed.deliveryMode}); sessionTaskQueue.remove(session.id, confirmed.id); }
      };
      const escapeHtml = text => text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
      document.body.innerHTML = '<section id="queuePanel"><div id="queueList"></div></section><textarea id="draft">还没发送的草稿</textarea>';
      const queuePanel = document.querySelector('#queuePanel');
      const queueList = document.querySelector('#queueList');
      ${between("function editQueuedTaskInline", "function finalizeVisibleStreamNow")}
      ${between("function moveSidebarOrder", "function clearSidebarSortIndicators")}
      ${between("async function startQueuedTask", "function renderQueue()")}
      ${between("function renderQueue()", "function renderSettings")}
      const task = sessionTaskQueue.enqueue('one', {text:'原来的补充', attachments:[{name:'图.png',dataUrl:'data:image/png;base64,AA=='}],quote:{messageId:'original'},context:{choice:'offline'}});
      renderQueue();
      check(queueList.querySelectorAll('.queue-handle svg circle').length === 6, 'Missing six-dot edit/drag handle');
      check(getComputedStyle(queueList.querySelector('.queue-remove')).opacity === '0', 'Trash should stay hidden away from its hit area');
      check(task.autoStart === false, 'New draft is already submitted');
      queueList.querySelector('.queue-task-label').click();
      const editor = queueList.querySelector('textarea');
      check(!document.querySelector('dialog') && task.editing, 'Editing must stay in its queue row');
      editor.value = '走线下办理';
      editor.dispatchEvent(new Event('input', {bubbles:true}));
      editor.focus();
      editor.setSelectionRange(2, 4);
      renderQueue();
      check(queueList.querySelector('textarea') === editor && editor.value === '走线下办理', 'Rerender replaced editor');
      check(document.activeElement === editor && editor.selectionStart === 2 && editor.selectionEnd === 4, 'Rerender lost caret');
      editor.blur();
      await processQueue();
      check(sent.length === 0, 'Blur or background dispatch sent a draft');
      finishQueuedTaskEdit(session, task);
      check(task.text === '走线下办理' && !task.editing && !task.autoStart, 'Draft save must keep an unsent task');
      check(task.attachments[0].name === '图.png' && task.quote.messageId === 'original' && task.context.choice === 'offline', 'Edit lost context');
      check(document.querySelector('#draft').value === '还没发送的草稿', 'Edit replaced composer');
      queueList.querySelector('.queue-task-label').click();
      const cancel = queueList.querySelector('textarea');
      cancel.value = '不要保存';
      cancel.dispatchEvent(new Event('input', {bubbles:true}));
      cancel.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true,cancelable:true}));
      await new Promise(resolve => setTimeout(resolve, 50));
      check(task.text === '走线下办理' && !task.editing, 'Cancel modified queue');
      sessionTaskQueue.pause('one'); renderQueue();
      check(sessionTaskQueue.isPaused('one'), 'Missing paused state');
      queueList.querySelector('.queue-task-label').click();
      const sendEditor = queueList.querySelector('textarea');
      sendEditor.value = '手动确认的最新补充';
      sendEditor.dispatchEvent(new Event('input', {bubbles:true}));
      sendEditor.dispatchEvent(new CompositionEvent('compositionstart'));
      queueList.querySelector('[data-action="start"]').click();
      sendEditor.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',isComposing:true,bubbles:true,cancelable:true}));
      check(sent.length === 0 && task.editing, 'Composition sent unfinished text');
      sendEditor.dispatchEvent(new CompositionEvent('compositionend'));
      sendEditor.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',keyCode:229,bubbles:true,cancelable:true}));
      sendEditor.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',shiftKey:true,bubbles:true,cancelable:true}));
      check(sent.length === 0, 'IME or Shift+Enter sent a draft');
      sendEditor.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true,cancelable:true}));
      check(sent.length === 1 && sent[0].text === '手动确认的最新补充' && sent[0].mode === 'steer', 'Enter did not send latest edit as a supplement');
      renderQueue();
      sessionTaskQueue.enqueue('one', {text:'按钮发送'});
      renderQueue();
      const sendButton = queueList.querySelector('[data-action="start"]');
      sendButton.click();
      sendButton.click();
      await new Promise(resolve => setTimeout(resolve, 50));
      check(sent.length === 2 && sent[1].text === '按钮发送' && sent[1].mode === 'steer', 'Button lost supplement mode or sent twice');
      renderQueue();
      sessionTaskQueue.enqueue('one', {text:'可删除的草稿'});
      renderQueue();
      queueList.querySelector('.queue-task-label').click();
      queueList.querySelector('[data-action="remove"]').click();
      check(sessionTaskQueue.list('one').length === 0 && queuePanel.hidden, 'Delete failed');
      const empty = sessionTaskQueue.enqueue('one', {text:'不能发送空草稿'});
      renderQueue();
      queueList.querySelector('.queue-task-label').click();
      const emptyEditor = queueList.querySelector('textarea');
      emptyEditor.value = '   ';
      emptyEditor.dispatchEvent(new Event('input'));
      emptyEditor.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true,cancelable:true}));
      check(sent.length === 2 && empty.editing, 'Empty edit was sent or discarded');
      sessionTaskQueue.clear('one'); renderQueue();
      const first = sessionTaskQueue.enqueue('one', {text:'先执行的补充'});
      const second = sessionTaskQueue.enqueue('one', {text:'后执行的补充'});
      renderQueue();
      const wait = duration => new Promise(resolve => setTimeout(resolve, duration));
      const pointer = (target, type, y=10) => target.dispatchEvent(new PointerEvent(type, {pointerId:1,button:0,clientX:10,clientY:y,bubbles:true,cancelable:true}));
      pointer(queueList.querySelector('.queue-task-label'), 'pointerdown');
      await wait(460);
      check(!state.queueSortDrag, 'Text body started dragging');
      pointer(document, 'pointerup');
      let firstRow = queueList.children[0];
      firstRow.setPointerCapture = () => {};
      pointer(firstRow.querySelector('.queue-handle'), 'pointerdown');
      await wait(460);
      check(state.queueSortDrag?.active, 'Long press did not activate sorting');
      const targetRow = queueList.children[1];
      const originalHitTest = document.elementFromPoint.bind(document);
      document.elementFromPoint = () => targetRow;
      pointer(document, 'pointermove', targetRow.getBoundingClientRect().bottom - 1);
      pointer(document, 'pointerup');
      document.elementFromPoint = originalHitTest;
      check(sessionTaskQueue.list('one')[0] === second && !first.editing, 'Drop failed or drag also triggered edit');
      check(!state.queueSortDrag && !document.body.classList.contains('queue-sort-active'), 'Drag state leaked');
      state.queueSortSuppressUntil = 0;
      firstRow = queueList.children[0];
      pointer(firstRow.querySelector('.queue-handle'), 'pointerdown');
      renderQueue();
      await wait(460);
      check(!state.queueSortDrag && !document.body.classList.contains('queue-sort-active'), 'Rerender left a drag timer running');
      firstRow = queueList.children[0];
      firstRow.setPointerCapture = () => {};
      pointer(firstRow.querySelector('.queue-handle'), 'pointerdown');
      await wait(460);
      pointer(document, 'pointercancel');
      check(!state.queueSortDrag && sessionTaskQueue.list('one')[0] === second, 'Cancelled drag changed order');
      first.deliveryInFlight = true;
      renderQueue();
      check([...queueList.children[1].querySelectorAll('button')].every(button => button.disabled), 'Submitted task remained editable');
      return {edit:true, cancel:true, remove:true, attachments:true, draft:true, pause:true, manual:true, caret:true, composition:true, enter:true, drag:true, locked:true};
    })()`);
    console.log("SUPPLEMENT_DOM=" + JSON.stringify(result));
    window.destroy();
    app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
} else {
  const test = require("node:test");
  const assert = require("node:assert/strict");
  test("supplement queue supports handle sorting, inline editing and explicit supplement delivery", () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const run = require("node:child_process").spawnSync(require("electron"), [__filename, "--queue-dom"], {
      cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 15000
    });
    assert.equal(run.status, 0, run.error?.message || run.stderr || run.stdout);
    assert.match(run.stdout, /SUPPLEMENT_DOM=.*"edit":true.*"pause":true/);
  });
}
