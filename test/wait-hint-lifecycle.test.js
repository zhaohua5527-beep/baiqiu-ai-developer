"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../renderer-v2/app.js"), "utf8");
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function fixture() {
  const element = () => ({ dataset: {}, children: [], replaceChildren(...children) { this.children = children; } });
  const panel = element();
  const root = { dataset: { lifecycle: "running" }, __executionOperationPanel: panel,
    querySelector: () => ({}), contains: node => node === panel };
  let metricsPaints = 0;
  const context = vm.createContext({ document: { createElement: element },
    reconcileExecutionChildren: (parent, rows) => { parent.children = rows; },
    updateExecutionOperationClocks() {}, paintExecutionReceivedBytes() { metricsPaints++; } });
  vm.runInContext(between("function executionToolKey(", "function executionActiveTools(")
    + between("function paintExecutionCurrentOperations(", "function executionThreeRowViewModel("), context);
  return { root, panel, metricsPaints: () => metricsPaints,
    paint: (events, tools = new Map()) => context.paintExecutionCurrentOperations(root, { events }, tools) };
}

const hint = (phase, sequence) => ({ eventId: "hint:" + sequence, turnSequence: sequence,
  provenance: "blackball_runtime", target: "execution_activity", kind: "lifecycle", status: "running", phase, message: phase });

test("only the newest waiting hint is displayed, then authored progress replaces it", () => {
  const view = fixture();
  const preparing = hint("context_prepare", 1);
  const ready = hint("context_ready", 2);
  view.paint([preparing]);
  assert.equal(view.panel.children.length, 1);
  view.paint([preparing, ready]);
  assert.equal(view.panel.children.length, 1);
  assert.equal(view.panel.children[0].children[0].textContent, "context_ready");
  view.paint([preparing, ready, { eventId: "stage", turnSequence: 3,
    provenance: "blackball_public", target: "structured", semanticType: "stage_result", message: "实际结果" }]);
  assert.equal(view.panel.children.length, 0);
  view.paint([preparing, ready, { eventId: "answer", turnSequence: 4, target: "answer", type: "answer_delta" }]);
  assert.equal(view.panel.children.length, 0);
  assert.ok(view.metricsPaints() >= 4);
});

test("active tools outrank wait hints, and terminal states retire the status panel", () => {
  const view = fixture();
  const tool = { eventId: "tool-event", toolCallId: "tool", turnId: "turn", turnSequence: 1,
    provenance: "blackball_tool", target: "execution", status: "running", message: "正在读取指定文件" };
  const tools = new Map([[JSON.stringify(["turn", "tool"]), tool]]);
  view.paint([tool, hint("context_ready", 2)], tools);
  assert.equal(view.panel.children[0].children[0].textContent, "正在读取指定文件");
  for (const state of ["completed", "interrupted", "failed"]) {
    view.root.dataset.lifecycle = state;
    view.paint([hint("context_ready", 2)]);
    assert.equal(view.panel.hidden, true);
  }
});
