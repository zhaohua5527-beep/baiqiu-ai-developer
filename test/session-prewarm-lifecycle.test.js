const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('prewarm coalesces concurrent requests but checks the backend again after completion', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer-v2/app.js'), 'utf8');
  let calls = 0;
  let finish;
  const context = vm.createContext({ api: { prewarmChat: () => {
    calls += 1;
    return new Promise((resolve) => { finish = resolve; });
  } } });
  vm.runInContext(source.slice(source.indexOf('const foregroundChatPrewarmRequests'), source.indexOf('function scheduleForegroundChatPrewarm')), context);
  const first = context.requestForegroundChatPrewarm('session');
  const duplicate = context.requestForegroundChatPrewarm('session');
  assert.equal(first, duplicate);
  assert.equal(calls, 1);
  finish(true);
  assert.equal(await first, true);
  const afterRestart = context.requestForegroundChatPrewarm('session');
  assert.equal(calls, 2);
  finish(false);
  assert.equal(await afterRestart, false);
  const retry = context.requestForegroundChatPrewarm('session');
  finish(true);
  assert.equal(await retry, true);
});

test('prewarm waits for both lanes and does not report success when execution preparation fails', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  let handler;
  let executionFinish;
  let foregroundStarted = false;
  const context = vm.createContext({
    ipcMain: { handle: (name, callback) => { handler = callback; } },
    loadDb: () => ({ settings: {} }),
    syncHermesRuntimeConfig: async () => {},
    prewarmExecutionSession: () => new Promise((resolve) => { executionFinish = resolve; }),
    prewarmForegroundSession: async () => { foregroundStarted = true; return true; },
    devLog: () => {}, publicBrandText: (value) => value
  });
  vm.runInContext(source.slice(source.indexOf('  ipcMain.handle("chat:prewarm"'), source.indexOf('  ipcMain.handle("session:select"')), context);
  let completed = false;
  const request = handler(null, 'session').then((value) => { completed = true; return value; });
  await new Promise(setImmediate);
  assert.equal(foregroundStarted, true);
  assert.equal(completed, false);
  executionFinish(false);
  assert.equal(await request, false);
  context.prewarmExecutionSession = async () => true;
  assert.equal(await handler(null, 'session'), true);
});
