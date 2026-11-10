"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { HmsMessageStreamDemux, HmsUpdateStreamDemux, stripHmsProgressEnvelopes } = require("../services/hms-progress");

function consumeChunks(text, size, options = {}) {
  const demux = new HmsMessageStreamDemux({ requireFinalEnvelope: false, ...options });
  const events = [];
  let answer = "";
  for (let offset = 0; offset < text.length; offset += size) {
    const parsed = demux.consume(text.slice(offset, offset + size));
    events.push(...parsed.progressEvents);
    answer += parsed.visibleDelta + parsed.answerDeltas.map(item => item.delta).join("");
  }
  const tail = demux.flush();
  events.push(...tail.progressEvents);
  answer += tail.visibleDelta + tail.answerDeltas.map(item => item.delta).join("");
  return { events, answer };
}

test("quoted progress opening preserves stage results and following Markdown at every chunk size", () => {
  const results = [1, 2, 3, 4].map(segment => ({ segmentId: String(segment), type: "stage_result", stage: "verify", status: "completed", message: `已回读验证第${segment}份文件，欠款合计4400元。` }));
  const answer = "\n\n## 最终结论\n\n| 方案 | 结果 |\n|---|---|\n| A | 可以做 |\n\n```python\nprint(3800)\n```\n";
  const text = results.map(event => '<baiqiu-progress">' + JSON.stringify(event) + '</baiqiu-progress>').join("") + answer;
  for (const size of [1, 2, 7, 19, 64, text.length]) {
    const parsed = consumeChunks(text, size);
    assert.deepEqual(parsed.events.map(event => event.message), results.map(event => event.message));
    assert.ok(parsed.events.every(event => event.semanticType === "stage_result"));
    assert.equal(parsed.answer, answer.trimStart());
  }
});

test("normal and quoted boundaries alternate without changing authored payload text", () => {
  const message = '引用原文中的 <baiqiu-progress"> 字样，不修改该字样。';
  const text = '<baiqiu-progress>{"segmentId":"1","type":"action","message":"读取账款资料"}</baiqiu-progress>'
    + "读取完毕。"
    + "<baiqiu-progress'>" + JSON.stringify({ segmentId: "2", type: "stage_result", status: "completed", message }) + '</baiqiu-progress>'
    + "继续交付。";
  const parsed = consumeChunks(text, 1);
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.events[1].message, message);
  assert.equal(parsed.answer, "读取完毕。继续交付。");
});

test("a batched final Markdown response after standard progress is not mistaken for process text", () => {
  const final = '## 可执行方案\n\n```python\nprint(3800)\n```\n';
  const parsed = consumeChunks('<baiqiu-progress>{"segmentId":"1","type":"stage_result","message":"欠款已核实为4400元"}</baiqiu-progress>' + final, 10000);
  assert.equal(parsed.answer, final);
});

test("unsupported progress attributes and invalid JSON do not manufacture stage results", () => {
  const invalid = '<baiqiu-progress extra="bad">{"type":"stage_result","message":"不可认定的内容"}</baiqiu-progress>'
    + '<baiqiu-progress">not-json</baiqiu-progress>';
  assert.deepEqual(consumeChunks(invalid, 1).events, []);
});

test("whole response cleanup strips quoted protocol wrappers while retaining final prose", () => {
  const text = '已有答案\n<baiqiu-progress">{"segmentId":"2","type":"stage_result","message":"已核实欠款4400元"}</baiqiu-progress>\n最终答案：可支配现金3800元。';
  assert.equal(stripHmsProgressEnvelopes(text), '已有答案\n\n最终答案：可支配现金3800元。');
});

test("thought transport still cannot turn following private prose into answer deltas", () => {
  const demux = new HmsUpdateStreamDemux({ requireFinalEnvelope: false });
  const parsed = demux.consume({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: '<baiqiu-progress">{"segmentId":"1","type":"stage_result","message":"已完成资料核对"}</baiqiu-progress>未公开的思考内容' } });
  assert.equal(parsed.visibleDelta, "");
  assert.deepEqual(parsed.answerDeltas, []);
});
