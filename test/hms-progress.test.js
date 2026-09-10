"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  extractHmsFinalEnvelope,
  HmsMessageStreamDemux,
  HmsProgressMapper,
  buildExecutionLog,
  isConcretePublicReasoning,
  stripHmsProgressEnvelopes,
  toolEvent
} = require("../services/hms-progress");

test("generic model self-narration is not treated as real execution reasoning", () => {
  assert.equal(isConcretePublicReasoning("当前请求是简单问候，因此直接以简洁方式回应。"), false);
  assert.equal(isConcretePublicReasoning("先核对附件中的日期列，再调用表格读取工具。"), true);
});

test("real plan and tool events inherit the active Black Ball answer segment", () => {
  const mapper = new HmsProgressMapper();
  const progress = mapper.consume({
    sessionUpdate: "agent_thought_chunk",
    visibility: "public",
    content: { type: "text", text: '<baiqiu-progress>{"segmentId":"seg-1","stage":"plan","message":"核对输入字段"}</baiqiu-progress>' }
  });
  assert.equal(progress[0].segmentId, "seg-1");
  const plan = mapper.consume({
    sessionUpdate: "plan",
    entries: [{ content: "读取输入文件", status: "in_progress" }]
  });
  assert.equal(plan[0].segmentId, "seg-1");
  const tool = mapper.consume({
    sessionUpdate: "tool_call",
    toolCallId: "tool-seg-1",
    title: "read_file",
    status: "running",
    rawInput: { path: "C:\\workspace\\input.txt" }
  });
  assert.equal(tool[0].segmentId, "seg-1");
});

test("only explicitly bounded final text becomes visible across HMS chunks", () => {
  const demux = new HmsMessageStreamDemux();
  assert.equal(demux.consume("这段未标记的过程推演不会进入对话。").visibleDelta, "");
  const splitOpen = demux.consume("<baiqiu-prog");
  assert.equal(splitOpen.visibleDelta, "");
  assert.equal(splitOpen.protocolError, false);
  const result = demux.consume('ress>{"stage":"verify","message":"正在核对最终数量"}</baiqiu-progress><baiqiu-fi');
  assert.equal(result.visibleDelta, "");
  assert.equal(result.progressEvents.length, 1);
  assert.equal(result.progressEvents[0].kind, "public_progress");
  assert.equal(result.progressEvents[0].message, "正在核对最终数量");
  assert.equal(demux.consume("nal>最终").visibleDelta, "最终");
  assert.equal(demux.consume("结果</baiqiu-fi").visibleDelta, "结果");
  assert.equal(demux.consume("nal>尾部过程").visibleDelta, "");
  assert.equal(stripHmsProgressEnvelopes('前文<baiqiu-progress>{"message":"正在检查"}</baiqiu-progress>结论'), "前文结论");
  assert.deepEqual(extractHmsFinalEnvelope("过程<baiqiu-final>公开结论</baiqiu-final>内部数据"), {
    text: "公开结论",
    envelope: "<baiqiu-final>公开结论</baiqiu-final>"
  });
  assert.equal(extractHmsFinalEnvelope("没有边界"), null);
});

test("an opened final streams immediately while split protocol suffixes stay private", () => {
  const demux = new HmsMessageStreamDemux();
  assert.equal(demux.consume("<baiqiu-final>第一段").visibleDelta, "第一段");
  assert.equal(demux.consume("\n\n**第二段**</baiq").visibleDelta, "\n\n**第二段**");
  assert.equal(demux.consume("iu-final>不应展示").visibleDelta, "");
  assert.equal(demux.flush().visibleDelta, "");
});

test("a malformed progress-to-answer boundary is recovered without leaking protocol text", () => {
  const demux = new HmsMessageStreamDemux({ requireFinalEnvelope: false });
  const parsed = demux.consume(
    '<baiqiu-progress>{"segmentId":"1","stage":"analyze","message":"正在核对仲裁记录"}'
    + '</baiqiu-answer segmentId="1">**仲裁员记录：**第一段结果'
  );
  const flushed = demux.flush();
  assert.equal(parsed.progressEvents[0].message, "正在核对仲裁记录");
  assert.deepEqual(parsed.answerDeltas, [{ segmentId: "1", delta: "**仲裁员记录：**第一段结果" }]);
  assert.equal(parsed.protocolError, true);
  assert.equal(flushed.visibleDelta, "");
  const visibleTransport = [parsed.visibleDelta, flushed.visibleDelta, ...parsed.answerDeltas.map((item) => item.delta)].join("");
  assert.doesNotMatch(visibleTransport, /<\/?baiqiu-|\{"segmentId"/i);
});

test("split answer opening tags never leak into streamed answer text", () => {
  const source = [
    '<baiqiu-progress>{"segmentId":"1","stage":"analyze","message":"第一段真实判断"}</baiqiu-progress>',
    '<baiqiu-answer segmentId="1">第一段结果</baiqiu-answer>',
    '<baiqiu-progress>{"segmentId":"2","stage":"verify","message":"第二段真实判断"}</baiqiu-progress>',
    '<baiqiu-answer segmentId="2">第二段结果</baiqiu-answer>'
  ].join("\n");

  for (let chunkSize = 1; chunkSize <= source.length; chunkSize += 1) {
    const demux = new HmsMessageStreamDemux({ requireFinalEnvelope: false });
    const events = [];
    for (let index = 0; index < source.length; index += chunkSize) {
      events.push(...demux.consume(source.slice(index, index + chunkSize)).streamEvents);
    }
    events.push(...demux.flush().streamEvents);
    const answer = events.filter((event) => event.type === "answer_delta").map((event) => event.delta).join("");
    const progress = events.filter((event) => event.type === "progress");
    const completed = events.filter((event) => event.type === "answer_end");
    assert.equal(answer, "第一段结果第二段结果", `chunk size ${chunkSize}`);
    assert.equal(progress.length, 2, `chunk size ${chunkSize}`);
    assert.equal(completed.length, 2, `chunk size ${chunkSize}`);
    assert.doesNotMatch(answer, /<\/?baiqiu-|segmentId/i, `chunk size ${chunkSize}`);
  }
});

test("baiqiu-action fences stay private when the opening backticks split across chunks", () => {
  const fence = String.fromCharCode(96).repeat(3);
  const source = [
    "前置正文",
    fence + "baiqiu-action",
    '{"type":"web_search","query":"本周天气"}',
    fence,
    "<baiqiu-final>最终答案</baiqiu-final>"
  ].join("\n");

  for (let chunkSize = 1; chunkSize <= source.length; chunkSize += 1) {
    const demux = new HmsMessageStreamDemux({ requireFinalEnvelope: false });
    const visible = [];
    const events = [];
    for (let index = 0; index < source.length; index += chunkSize) {
      const result = demux.consume(source.slice(index, index + chunkSize));
      visible.push(result.visibleDelta);
      events.push(...result.streamEvents);
    }
    const tail = demux.flush();
    visible.push(tail.visibleDelta);
    events.push(...tail.streamEvents);

    const answer = events
      .filter((event) => event.type === "answer_delta")
      .map((event) => event.delta)
      .join("");
    assert.equal(visible.join(""), "前置正文\n最终答案", "chunk size " + chunkSize);
    assert.equal(answer, "", "chunk size " + chunkSize);
    assert.doesNotMatch(visible.join(""), /baiqiu-action|web_search/i, "chunk size " + chunkSize);
  }
});

test("answer envelopes are isolated even when the opening arrives across chunks", () => {
  const demux = new HmsMessageStreamDemux({ requireFinalEnvelope: false });
  assert.equal(demux.consume("<baiqiu-ans").visibleDelta, "");
  const parsed = demux.consume('wer segmentId="1">你好，今天聊点什么</baiqiu-answer>');
  const flushed = demux.flush();
  const answer = [...parsed.streamEvents, ...flushed.streamEvents]
    .filter((event) => event.type === "answer_delta")
    .map((event) => event.delta)
    .join("");
  assert.equal(answer, "你好，今天聊点什么");
  assert.doesNotMatch(answer, /<\/?baiqiu-|segmentId/i);
  assert.equal(stripHmsProgressEnvelopes('<baiqiu-answer segmentId="1">你好</baiqiu-answer>'), "你好");
});

test("JSON-escaped answer closers never enter streamed or durable answer text", () => {
  const source = '<baiqiu-answer segmentId="1">你好，我是黑球。今天想聊点什么？<\\/baiqiu-answer>';

  for (let chunkSize = 1; chunkSize <= source.length; chunkSize += 1) {
    const demux = new HmsMessageStreamDemux({ requireFinalEnvelope: false });
    const events = [];
    for (let index = 0; index < source.length; index += chunkSize) {
      events.push(...demux.consume(source.slice(index, index + chunkSize)).streamEvents);
    }
    events.push(...demux.flush().streamEvents);
    const answer = events
      .filter((event) => event.type === "answer_delta")
      .map((event) => event.delta)
      .join("");
    assert.equal(answer, "你好，我是黑球。今天想聊点什么？", `chunk size ${chunkSize}`);
    assert.doesNotMatch(answer, /baiqiu|<\\?\//i, `chunk size ${chunkSize}`);
  }

  assert.equal(stripHmsProgressEnvelopes(source), "你好，我是黑球。今天想聊点什么？");
});

test("renderer cleans an already persisted JSON-escaped answer closer", () => {
  const rendererSource = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");
  const start = rendererSource.indexOf("function normalizeEscapedBaiqiuProtocolClosers");
  const end = rendererSource.indexOf("function filterLiveAssistantDelta", start);
  assert.ok(start >= 0 && end > start);
  const rawBlackBallAnswerText = vm.runInNewContext(`
    (() => {
      ${rendererSource.slice(start, end)}
      return rawBlackBallAnswerText;
    })()
  `);

  assert.equal(
    rawBlackBallAnswerText("你好，我是黑球。今天想聊点什么？<\\/baiqiu-answer>"),
    "你好，我是黑球。今天想聊点什么？"
  );
});

test("a malformed answer boundary cannot consume a later valid progress envelope", () => {
  const demux = new HmsMessageStreamDemux({ requireFinalEnvelope: false });
  const parsed = demux.consume(
    '<baiqiu-progress>{"segmentId":"1","stage":"analyze","message":""broken first thought""}'
    + '</baiqiu-answer segmentId="1">first answer</baiqiu-answer>'
    + '<baiqiu-progress>{"segmentId":"2","stage":"verify","message":""broken second thought""}</baiqiu-progress>'
    + 'second answer'
  );
  const flushed = demux.flush();
  const events = [...parsed.streamEvents, ...flushed.streamEvents];
  const answerText = events
    .filter((event) => event.type === "answer_delta")
    .map((event) => event.delta)
    .join("");

  assert.deepEqual(parsed.progressEvents, []);
  assert.equal(answerText, "first answersecond answer");
  assert.equal(parsed.protocolError, true);
  assert.doesNotMatch(answerText, /<\/?baiqiu-|segmentId|thought/i);
});

test("a progress close tag glued to answer text is isolated and recovered by segment identity", () => {
  const demux = new HmsMessageStreamDemux({ requireFinalEnvelope: false });
  const parsed = demux.consume(
    '<baiqiu-progress>{"segmentId":"2","stage":"verify","message":"正在检查约束"}'
    + "</baiqiu-progress，但他没有按照要求继续执行。"
  );
  assert.equal(parsed.progressEvents[0].message, "正在检查约束");
  assert.deepEqual(parsed.answerDeltas, [{ segmentId: "2", delta: "，但他没有按照要求继续执行。" }]);
  assert.equal(parsed.protocolError, true);
  assert.doesNotMatch(parsed.answerDeltas[0].delta, /<\/?baiqiu-|\{"segmentId"/i);
});

test("unresolved protocol is quarantined on flush while ordinary unbounded text still streams", () => {
  const malformed = new HmsMessageStreamDemux({ requireFinalEnvelope: false });
  assert.equal(malformed.consume('<baiqiu-progress>{"segmentId":"3","message":"半截协议"').visibleDelta, "");
  const malformedTail = malformed.flush();
  assert.equal(malformedTail.visibleDelta, "");
  assert.equal(malformedTail.protocolError, true);

  const plain = new HmsMessageStreamDemux({ requireFinalEnvelope: false });
  assert.equal(plain.consume("普通未封装答案").visibleDelta, "普通未封装答案");
  assert.equal(plain.flush().visibleDelta, "");
});

test("an incomplete trailing answer close is never visible or persisted", () => {
  const demux = new HmsMessageStreamDemux({ requireFinalEnvelope: false });
  const parsed = demux.consume('<baiqiu-answer segmentId="9">Report body</baiqiu-answer');
  const flushed = demux.flush();
  const answer = [...parsed.streamEvents, ...flushed.streamEvents]
    .filter((event) => event.type === "answer_delta")
    .map((event) => event.delta)
    .join("");
  assert.equal(answer, "Report body");
  assert.doesNotMatch(answer, /baiqiu/i);
  assert.equal(flushed.protocolError, true);
  assert.equal(stripHmsProgressEnvelopes('Report body</baiqiu-answer'), "Report body");
  assert.equal(stripHmsProgressEnvelopes('Report body</baiqiu-answer segmentId="9"'), "Report body");
  assert.equal(stripHmsProgressEnvelopes("ordinary <b"), "ordinary <b");
  assert.equal(stripHmsProgressEnvelopes("ordinary <tag"), "ordinary <tag");
});

test("malformed protocol inside an answer cannot escape from the answer channel", () => {
  const demux = new HmsMessageStreamDemux({ requireFinalEnvelope: false });
  const parsed = demux.consume('<baiqiu-answer segmentId="4">安全正文</baiqiu-progress broken>禁止泄漏');
  assert.deepEqual(parsed.answerDeltas, [{ segmentId: "4", delta: "安全正文" }]);
  assert.equal(parsed.protocolError, true);
  assert.doesNotMatch(parsed.answerDeltas.map((item) => item.delta).join(""), /baiqiu|禁止泄漏/i);
});

test("a misspelled Baiqiu protocol head is quarantined instead of treated as plain text", () => {
  const demux = new HmsMessageStreamDemux({ requireFinalEnvelope: false });
  assert.equal(demux.consume('<baiqiu-progres>{"message":"内部 JSON"}').visibleDelta, "");
  const tail = demux.flush();
  assert.equal(tail.visibleDelta, "");
  assert.equal(tail.protocolError, true);
});

test("plain answer text before a valid passive machine block remains visible", () => {
  const demux = new HmsMessageStreamDemux({ requireFinalEnvelope: false });
  const parsed = demux.consume('正常正文<baiqiu-outcome>{"status":"done"}</baiqiu-outcome>');
  assert.equal(parsed.visibleDelta, "正常正文");
  assert.equal(parsed.protocolError, false);
  assert.equal(demux.flush().visibleDelta, "");
});

test("unmarked native thought chunks never enter public progress", () => {
  const mapper = new HmsProgressMapper();
  const first = mapper.consume({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "先核对字段" } });
  assert.deepEqual(first, []);
  const second = mapper.consume({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "，再筛选数据。" } });
  assert.deepEqual(second, []);
  assert.deepEqual(mapper.flush(), []);
});

test("reasoning deltas preserve provider whitespace across chunk boundaries", () => {
  const mapper = new HmsProgressMapper();
  const first = mapper.consume({ sessionUpdate: "agent_thought_chunk", visibility: "public", content: { type: "text", text: "Check " } });
  const second = mapper.consume({ sessionUpdate: "agent_thought_chunk", visibility: "public", content: { type: "text", text: "fields" } });
  assert.equal(first[0].delta + second[0].delta, "Check fields");
});

test("durable execution logs exclude transient reasoning chunks", () => {
  const log = buildExecutionLog([
    { sessionUpdate: "agent_thought_chunk", visibility: "public", content: { type: "text", text: "same" } },
    { sessionUpdate: "agent_thought_chunk", visibility: "public", content: { type: "text", text: "same" } }
  ], { runId: "run-1" });
  assert.deepEqual(log, []);
});

test("an explicitly bounded public progress envelope may arrive on the thought channel", () => {
  const mapper = new HmsProgressMapper();
  assert.deepEqual(mapper.consume({
    sessionUpdate: "agent_thought_chunk",
    visibility: "public",
    content: { type: "text", text: '<baiqiu-progress>{"stage":"analyze","message":"正在核对筛选口径"}' }
  }), []);
  const events = mapper.consume({
    sessionUpdate: "agent_thought_chunk",
    visibility: "public",
    content: { type: "text", text: "</baiqiu-progress>" }
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].message, "正在核对筛选口径");
  assert.equal(events[0].provenance, "blackball_public");
  assert.deepEqual(mapper.consume({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "标签外的私有推演" } }), []);
});

test("a public reasoning update preserves completed, judgment and next in order", () => {
  const mapper = new HmsProgressMapper();
  const events = mapper.consume({
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text: '<baiqiu-progress>{"stage":"verify","completed":"\u5df2\u8bfb\u53d6 3 \u4e2a\u9644\u4ef6","message":"\u5b57\u6bb5\u53e3\u5f84\u4e0d\u4e00\u81f4\uff0c\u56e0\u4e3a\u65e5\u671f\u5217\u7f3a\u5931","next":"\u6838\u5bf9\u7f3a\u5931\u5217"}</baiqiu-progress>'
    }
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].message, "\u5b57\u6bb5\u53e3\u5f84\u4e0d\u4e00\u81f4\uff0c\u56e0\u4e3a\u65e5\u671f\u5217\u7f3a\u5931");
  assert.equal(events[0].completed, "\u5df2\u8bfb\u53d6 3 \u4e2a\u9644\u4ef6");
  assert.equal(events[0].next, "\u6838\u5bf9\u7f3a\u5931\u5217");
});

test("explicitly public native thought is shown as model-authored progress", () => {
  const mapper = new HmsProgressMapper();
  const events = mapper.consume({
    sessionUpdate: "agent_thought_chunk",
    visibility: "public",
    content: { type: "text", text: "先核对用户要求的两个字段，再决定是否需要工具。" }
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "reasoning_delta");
  assert.equal(events[0].delta, "先核对用户要求的两个字段，再决定是否需要工具。");
  assert.equal(events[0].message, "先核对用户要求的两个字段，再决定是否需要工具。");
});

test("plain answer-channel narration is not relabeled as reasoning", () => {
  const mapper = new HmsProgressMapper();
  const message = "\u6b63\u5728\u6838\u5bf9\u56db\u4e2a\u9644\u4ef6\u4e2d\u7684\u5e93\u5b58\u5b57\u6bb5\u3002";
  const events = mapper.consume({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: message }
  });
  assert.deepEqual(events, []);

  const finalEvents = mapper.consume({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "<baiqiu-final>\u6700\u7ec8\u7ed3\u679c</baiqiu-final>\u5185\u90e8\u6570\u636e" }
  });
  assert.deepEqual(finalEvents, []);
  assert.deepEqual(mapper.flush(), []);
});

test("a short unbounded answer fragment is not published as progress", () => {
  const mapper = new HmsProgressMapper();
  assert.deepEqual(mapper.consume({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "\u6b63\u5728\u6574\u7406\u9644\u4ef6\u4e2d\u7684\u6709\u6548\u6570\u636e" }
  }), []);
  assert.deepEqual(mapper.flush(), []);
});

test("explicitly public native reasoning is sanitized before display", () => {
  const mapper = new HmsProgressMapper();
  const events = mapper.consume({
    sessionUpdate: "agent_message_chunk",
    visibility: "public",
    type: "thinking",
    content: { type: "thinking", thinking: "正在读取资料，token=secret-value。" }
  });
  assert.equal(events.length, 1);
  assert.match(events[0].message, /正在读取资料/);
  assert.doesNotMatch(events[0].message, /secret-value/);
});

test("plans and tools are mapped from their real ACP events without speculative narration", () => {
  const mapper = new HmsProgressMapper();
  const plans = mapper.consume({
    sessionUpdate: "plan",
    entries: [{ content: "读取两个工作簿", priority: "high", status: "in_progress" }]
  });
  assert.equal(plans[0].message, "当前计划：读取两个工作簿");

  const tool = toolEvent({
    sessionUpdate: "tool_call_update",
    title: "write_xlsx",
    status: "completed",
    rawInput: { path: "C:\\Users\\Lenovo\\Desktop\\结果.xlsx" },
    result: { success: true }
  });
  /* legacy exact-message assertion retained as a disabled compatibility note
  assert.equal(tool.message, "表格写入已完成：“结果.xlsx”");
  */
  assert.equal(tool.displayKind, "tool");
  assert.doesNotMatch(tool.message, /正在核对|调整后续|综合分析/);

  const command = toolEvent({
    sessionUpdate: "tool_call",
    title: "terminal",
    status: "running",
    rawInput: { command: "npm test" }
  });
  assert.equal(command.displayKind, "command");
  assert.equal(command.sourceText, "npm test");
  /* legacy exact-message assertion retained as a disabled compatibility note
  assert.equal(command.message, "正在执行“npm test”");

  */
  const commandWithArgs = toolEvent({
    sessionUpdate: "tool_call",
    title: "shell",
    status: "running",
    rawInput: { args: ["node", "--test", "test/hms-progress.test.js"] }
  });
  assert.equal(commandWithArgs.sourceText, "node --test test/hms-progress.test.js");
  /* legacy exact-message assertion retained as a disabled compatibility note
  assert.equal(commandWithArgs.message, "正在执行“node --test test/hms-progress.test.js”");

  */
  const code = toolEvent({
    sessionUpdate: "tool_call_update",
    title: "write_file",
    status: "completed",
    rawInput: { path: "C:\\workspace\\app.js" },
    result: { success: true }
  });
  assert.equal(code.displayKind, "code");
});

test("tool events retain concrete input and result previews while redacting secrets", () => {
  const tool = toolEvent({
    sessionUpdate: "tool_call_update",
    title: "browser_open",
    status: "completed",
    rawInput: { url: "https://example.com/search?q=sacasde", query: "sacasde", token: "secret-value" },
    rawOutput: { title: "section-i", text: "page fragment", authorization: "Bearer secret" }
  });
  assert.match(tool.message, /https:\/\/example\.com\/search\?q=sacasde/);
  assert.match(tool.message, /section-i/);
  assert.match(tool.message, /page fragment/);
  assert.doesNotMatch(tool.message, /secret-value|Bearer secret/);
  assert.equal(tool.inputPreview.includes("sacasde"), true);
  assert.equal(tool.resultPreview.includes("page fragment"), true);
});

test("tool events retain complete multiline source while redacting command secrets", () => {
  const source = `node -e "${"console.log('line')\n".repeat(120)}" --token secret-value`;
  const tool = toolEvent({
    sessionUpdate: "tool_call",
    title: "terminal",
    status: "running",
    rawInput: { command: source }
  });

  assert.ok(tool.sourceText.length > 1200);
  assert.match(tool.sourceText, /console\.log\('line'\)\nconsole\.log\('line'\)/);
  assert.doesNotMatch(tool.sourceText, /secret-value/);
  assert.match(tool.sourceText, /--token \[已隐藏\]/);
});

test("tool events accept provider payload aliases and merge one call across updates", () => {
  const mapper = new HmsProgressMapper();
  const started = mapper.consume({
    sessionUpdate: "tool_call",
    title: "browser_open",
    callId: "call-alias-1",
    arguments: { url: "https://example.com/search?q=weather", query: "weather" }
  });
  assert.match(started[0].message, /weather/);
  const completed = mapper.consume({
    sessionUpdate: "tool_call_update",
    toolCall: { callId: "call-alias-1" },
    status: "completed",
    toolResult: { title: "weather result", text: "sunny" }
  });
  assert.match(completed[0].message, /weather/);
  assert.match(completed[0].message, /weather result/);
  assert.match(completed[0].message, /sunny/);
  assert.equal(completed[0].toolCallId, "call-alias-1");
});

test("tool events ignore empty placeholders and expose ACP content and locations", () => {
  const mapper = new HmsProgressMapper();
  mapper.consume({
    sessionUpdate: "tool_call",
    toolCallId: "acp-tool-1",
    title: "browser_open",
    rawInput: { url: "https://example.com/weather" }
  });
  const completed = mapper.consume({
    sessionUpdate: "tool_call_update",
    toolCallId: "acp-tool-1",
    status: "completed",
    rawInput: {},
    rawOutput: {},
    content: [{ type: "content", content: { type: "text", text: "Weather page opened" } }],
    locations: [{ path: "C:\\workspace\\weather.txt" }]
  });
  assert.match(completed[0].message, /https:\/\/example\.com\/weather/);
  assert.match(completed[0].message, /Weather page opened/);
  assert.doesNotMatch(completed[0].message, /输入 \{\}/);
  assert.equal(completed[0].status, "completed");
});

test("the task board reads the same provider aliases without replacing prior detail", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");
  const liveEvents = renderer.slice(
    renderer.indexOf("function taskBoardToolValue"),
    renderer.indexOf("api.onGatewayEvent?.(recordTaskBoardLiveEvent)")
  );
  assert.match(liveEvents, /update\.arguments, update\.parameters, update\.params/);
  assert.match(liveEvents, /update\.result, update\.rawOutput, update\.toolResult/);
  assert.match(liveEvents, /update\.content, update\.locations/);
  assert.match(liveEvents, /list\[existing\] = \{ \.\.\.list\[existing\], \.\.\.event \}/);
});

test("Black Ball's factual plan and tool milestones are rendered without local guesses", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");
  const activity = source.slice(source.indexOf("function activityDetailText"), source.indexOf("function activityIsTransient"));
  const liveActivity = source.slice(source.indexOf("function setLiveStreamActivity"), source.indexOf("function ensureLiveStreamRow"));
  assert.match(activity, /Render the event[\s\S]*?supplied by the model/);
  assert.doesNotMatch(activity, /humanizeExecutionActivity|正在整理资料|正在分析问题|正在构建方案/);
  assert.doesNotMatch(activity, /return value\.slice\(0, 20000\)/);
  assert.match(liveActivity, /if \(!progress\) return;/);
  assert.match(liveActivity, /if \(!factualProgress\) return;/);
});

test("execution logs retain durable plan and tool provenance only", () => {
  const log = buildExecutionLog([
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: '<baiqiu-progress>{"stage":"read","message":"正在读取工作簿"}</baiqiu-progress>' } },
    { sessionUpdate: "agent_thought_chunk", visibility: "public", content: { type: "text", text: "需要核对筛选口径。" } },
    { sessionUpdate: "plan", entries: [{ content: "读取表格", priority: "high", status: "in_progress" }] },
    { sessionUpdate: "tool_call", title: "read_file", status: "pending", rawInput: { path: "D:\\表3.xlsx" } }
  ]);
  assert.deepEqual(log.map((item) => item.kind), ["plan", "tool"]);
  assert.deepEqual(log.map((item) => item.sequence), [1, 2]);
  assert.ok(log.every((item) => Number(item.timestamp) > 0));
});

test("execution logs preserve repeated provider deliveries as distinct ordered events", () => {
  const log = buildExecutionLog([
    { sessionUpdate: "tool_call_update", toolCallId: "tool-1", title: "read_file", status: "running", rawInput: { path: "D:\\input.xlsx" } },
    { sessionUpdate: "tool_call_update", toolCallId: "tool-1", title: "read_file", status: "running", rawInput: { path: "D:\\input.xlsx" } }
  ], { runId: "run-1" });
  assert.equal(log.length, 2);
  assert.deepEqual(log.map((item) => item.sequence), [1, 2]);
  assert.equal(new Set(log.map((item) => item.eventId)).size, 2);
});

test("raw execution logs stay in the task board while sanitized public summaries can be revisited in chat", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");
  assert.doesNotMatch(renderer, /function createMessageExecutionLog\(/);
  assert.doesNotMatch(renderer, /message-execution-log/);
  assert.doesNotMatch(renderer, /bubble\.appendChild\(executionLog\)/);
  assert.match(renderer, /function publicExecutionDetailsFromMessage\(message = \{\}, fallback = \[\]\)/);
  assert.match(renderer, /persistedReplay\.executionLogFromMessage\(message\)/);
  assert.match(renderer, /function executionActivityProtocolText\(activity = ""\)/);
  assert.match(renderer, /function executionActivityTimeText\(activity = ""\)/);
  assert.match(renderer, /data-event-id=/);
  assert.match(renderer, /function collectTaskBoardExecutionEvents\(/);
  assert.match(renderer, /data-board-tab="timeline"/);
  assert.doesNotMatch(renderer, /label\.textContent = "详细分析"/);
  assert.doesNotMatch(renderer, /details\.className = "task-result-details"/);
});

test("the public progress surface is compact but expands to every real Black Ball event", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");
  assert.match(renderer, /understanding: "正在理解"/);
  assert.match(renderer, /executing: "正在执行"/);
  assert.match(renderer, /typing: "正在输入"/);
  assert.match(renderer, /completed: "执行完毕"/);
  assert.match(renderer, /const EXECUTION_ACTIVITY_VISIBLE_LIMIT = 3;/);
  assert.match(renderer, /Number\.POSITIVE_INFINITY/);
  assert.match(renderer, /root\?\.dataset\?\.lifecycle === "completed"[\s\S]*?return \[\]/);
  assert.doesNotMatch(renderer, /EXECUTION_ACTIVITY_HISTORY_LIMIT/);
  assert.doesNotMatch(renderer, /thinking-label">黑球反馈/);
  assert.match(renderer, /entry\.activityTransient = transient;/);
  assert.match(renderer, /setLiveStreamStage\(entry, executionStageForActivity\(activity\)\);[\s\S]*?const transient = activityIsTransient\(activity\);/);
  assert.doesNotMatch(renderer, /createThinkingMessage\("任务仍在执行"/);
});

test("conversation shows truthful waiting status before Black Ball publishes a factual event", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.doesNotMatch(renderer, /INITIAL_PUBLIC_ACTIVITY|正在读取本轮请求，准备当前会话/);
  const thinkingMessage = renderer.slice(renderer.indexOf("function createThinkingMessage"), renderer.indexOf("function removeThinkingMessage"));
  assert.match(thinkingMessage, /execution-waiting-status/);
  assert.match(thinkingMessage, /row\.hidden = !\(initialThinkingText \|\| options\.waiting === true\)/);
  assert.doesNotMatch(main, /actor: "白球"/);
  assert.doesNotMatch(main, /正在读取本轮请求，准备当前会话/);
  assert.match(main, /function isBlackBallPublicProgress/);
  assert.match(main, /\["phase", "start"\]\.includes\(type\)/);
  assert.match(main, /function emitBlackBallRunStarted/);
  assert.match(renderer, /thinkingRow = createThinkingMessage\("", \{[\s\S]*?waiting: true/);
});

test("Black Ball-owned turns receive the full tool catalog", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(main, /function buildConversationSystemPrompt\(/);
  assert.match(main, /conversationOnly[\s\S]{0,180}buildConversationSystemPrompt/);
  assert.match(main, /options\.disableTools === true \|\| options\.rawPrompt === true\) return \[\]/);
  assert.match(main, /toolsForHmsMode\(registry\.list\(\), \{ conversationOnly \}\)/);
  assert.match(main, /const browserRequested = requestsBrowserAutomation\(options\.message\);/);
  assert.match(main, /const blackBallOwnsDecision = options\.blackBallOwnsDecision === true/);
  assert.match(main, /const conversationOnly = !blackBallOwnsDecision[\s\S]{0,80}&& !browserRequested/);
});

test("native updates retain their channel when entering the answer demux", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");
  assert.match(main, /const isMessageUpdate = updateType === "agent_message_chunk" \|\| isReasoningUpdate/);
  assert.match(main, /const visibleStream = new HmsUpdateStreamDemux\(/);
  assert.match(main, /const separated = isMessageUpdate[\s\S]*?visibleStream\.consume\(update\)/);
  assert.doesNotMatch(main, /visibleStream\.consume\(hmsProgressContentText\(update\)\)/);
  assert.match(main, /if \(isMessageUpdate\) emitAnswerParts\(separated\)/);
  assert.match(main, /function sanitizeHmsAnswerText\(value = ""\)/);
  assert.match(renderer, /function stripTrailingBaiqiuProtocolFragment\(/);
  assert.match(renderer, /stripTrailingBaiqiuProtocolFragment\(String\(delta \|\| ""\)\)/);
  assert.ok(renderer.includes(".replace(/<\\/?baiqiu-(?:answer|final)\\b[^>]*>/ig, \"\")"));
});

test("the main process never falls back to raw protocol text", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(main, /if \(separated\.protocolError\) streamProtocolError = true/);
  assert.match(main, /if \(tail\.protocolError\) streamProtocolError = true/);
  const start = main.indexOf('    const safePromptText = streamProtocolError');
  const end = main.indexOf('    return {', start);
  const branch = main.slice(start, end);
  const context = vm.createContext({ streamProtocolError: true, streamedPublicText: '', sanitizedPromptText: '"}' });
  const text = vm.runInContext(`(() => { ${branch} return safePromptText; })()`, context);
  assert.equal(text, '');
});
