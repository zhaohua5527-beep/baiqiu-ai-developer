"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { enrichAttachmentContent } = require("../services/attachment-analysis-service");
const SessionTaskQueue = require("../renderer-v2/session-task-queue");
const {
  buildQuotedPrompt,
  mergeQuoteAttachments,
  prepareQuotedInput,
  resolveQuoteContext
} = require("../services/quote-context");

test("restores the quoted message, nearby turns, and its file/image attachments", () => {
  const messages = [
    { id: "u1", role: "user", text: "先看这份资料" },
    { id: "a1", role: "assistant", text: "资料里有一张图和一个表格" },
    { id: "u2", role: "user", text: "请继续", attachments: [{ id: "file-1", name: "报价.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", path: "D:/报价.xlsx" }], images: [{ id: "img-1", name: "截图.png", mimeType: "image/png", path: "D:/截图.png" }] },
    { id: "current", role: "user", text: "当前请求" }
  ];
  const quote = resolveQuoteContext({
    messages,
    quote: { sessionId: "s1", messageId: "u2", source: "你", text: "请继续" },
    sessionId: "s1",
    excludeMessageId: "current"
  });

  assert.equal(quote.messageId, "u2");
  assert.equal(quote.text, "请继续");
  assert.deepEqual(quote.attachments.map((item) => item.name), ["报价.xlsx", "截图.png"]);
  assert.deepEqual(quote.relatedMessages.map((item) => item.text), ["先看这份资料", "资料里有一张图和一个表格"]);

  const prompt = buildQuotedPrompt("请判断是否需要修改", quote);
  assert.match(prompt, /引用原文：\n请继续/);
  assert.match(prompt, /引用附件：报价\.xlsx、截图\.png/);
  assert.match(prompt, /当前请求：\n+请判断是否需要修改/);
});

test("same cached file with different IDs is sent once; distinct inline images survive", () => {
  const files = mergeQuoteAttachments(
    [{ id: "cache", path: "D:\\cache\\photo.png" }],
    [{ id: "render", path: "d:/cache/photo.png" }, { dataUrl: "data:image/png;base64,AA==" }, { dataUrl: "data:image/png;base64,AQ==" }]
  );
  assert.equal(files.length, 3);
  assert.equal(files[1].mimeType, "image/png");
  assert.equal(files[2].mimeType, "image/png");
});

test("selection keeps original context and excludes later unrelated user turns", () => {
  const messages = [{ id: "original", role: "user", text: "第一句\n第二句" }, { id: "reply", role: "assistant", text: "解释" }, { id: "unrelated", role: "user", text: "另一件事" }];
  const quote = resolveQuoteContext({ messages, quote: { messageId: "original", selectionText: "第二句" } });
  assert.equal(quote.text, "第二句");
  assert.equal(quote.fullText, "第一句\n第二句");
  assert.deepEqual(quote.relatedMessages.map((item) => item.text), ["解释"]);
  assert.ok(!buildQuotedPrompt("继续", quote).includes("另一件事"));
});

test("nested quote restores the original source across sessions after serialization", async () => {
  const stored = JSON.parse(JSON.stringify({
    origin: [{ id: "original", role: "user", text: "真正的问题", attachments: [{ id: "file", name: "原文.txt", textContent: "原文正文" }] }],
    recent: [{ id: "followup", role: "user", text: "继续回答", raw: { quote: { sessionId: "origin", messageId: "original" } } }, { id: "failure", role: "assistant", text: "本次请求未完成" }]
  }));
  const restored = await prepareQuotedInput({ sessionId: "destination", message: "回答引用的问题", quote: { sessionId: "recent", messageId: "failure" } }, {
    loadMessages: async (id) => stored[id] || [], enrichAttachments: async (items) => items
  });
  assert.match(restored.message, /真正的问题/);
  assert.equal(restored.attachments[0].textContent, "原文正文");
  assert.equal(restored.message.split("当前请求：").length, 2);
});

test("quote cycles terminate and missing sources are explicitly disclosed", async () => {
  const messages = [{ id: "cycle", role: "user", text: "引用", raw: { quote: { messageId: "cycle" } } }];
  const dependencies = { loadMessages: async () => messages, enrichAttachments: async (items) => items };
  const restored = await prepareQuotedInput({ sessionId: "same", message: "继续", quote: { messageId: "cycle" } }, dependencies);
  assert.ok(restored.message.length < 2000);
  const missing = await prepareQuotedInput({ message: "继续", quote: { messageId: "missing", text: "保留的引用" } }, dependencies);
  assert.match(missing.message, /原消息未找到/);
  assert.match(missing.message, /保留的引用/);
});

test("queue retains separate selections and source sessions", () => {
  const queue = new SessionTaskQueue();
  for (const quote of [{ sessionId: "one", messageId: "same", selectionText: "甲" }, { sessionId: "one", messageId: "same", selectionText: "乙" }, { sessionId: "two", messageId: "same", selectionText: "甲" }]) {
    queue.enqueue("destination", { text: "解释", quote });
  }
  assert.equal(queue.list("destination").length, 3);
  assert.equal(queue.list("destination")[2].quote.sessionId, "two");
});

test("renderer transports the quote separately without putting it in the user instruction", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../renderer-v2/app.js"), "utf8");
  const received = [];
  const harness = vm.createContext({ api: { productSubmitTask: async (payload) => { received.push(payload); } } });
  vm.runInContext(source.slice(source.indexOf("async function submitProductInput("), source.indexOf("function renderProductDashboard(")), harness);
  const quote = { sessionId: "source", messageId: "image-message", attachments: [{ id: "image", path: "D:/cached.png" }], selectionText: "这张图" };
  await harness.submitProductInput({ id: "destination" }, "解释这个", { quote });
  assert.equal(received[0].message, "解释这个");
  assert.equal(received[0].sessionId, "destination");
  assert.equal(received[0].quote, quote);
});

test("failed file restoration preserves the real analysis error instead of pretending to read it", async () => {
  const restored = await prepareQuotedInput({ message: "解释", quote: { text: "旧文件", attachments: [{ path: "Z:/missing-quote-evidence.txt", name: "evidence.txt" }] } }, {
    loadMessages: async () => [],
    enrichAttachments: (items) => Promise.all(items.map((item) => enrichAttachmentContent(item, { resolvePath: () => "" })))
  });
  assert.equal(restored.attachments[0].analysisError, "附件文件路径不可用");
  assert.match(restored.message, /原消息未找到/);
});

test("request identity changes with quoted source, selection or attachment", () => {
  const source = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const harness = vm.createContext({ requestContentDigest: JSON.stringify, requestAttachmentFingerprint: (item) => item, stableRequestFingerprintValue: (item) => item });
  vm.runInContext(source.slice(source.indexOf("function productRequestFingerprint("), source.indexOf("function idempotencyKeyReusedResult(")), harness);
  const base = { message: "解释", quote: { sessionId: "source", messageId: "same" } };
  const fingerprint = harness.productRequestFingerprint(base);
  for (const patch of [{ sessionId: "other" }, { selectionText: "不同选中内容" }, { attachments: [{ path: "D:/different.pdf" }] }]) {
    assert.notEqual(harness.productRequestFingerprint({ ...base, quote: { ...base.quote, ...patch } }), fingerprint);
  }
  assert.ok(!Object.hasOwn(JSON.parse(harness.productRequestFingerprint({ message: "未引用" })), "quote"));
});

test("ordinary product submission delivers restored file text and image bytes to the runtime", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-quote-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4ZkAAAAASUVORK5CYII=", "base64");
  fs.writeFileSync(path.join(directory, "evidence.txt"), "真正的附件正文：蓝色按钮");
  fs.writeFileSync(path.join(directory, "evidence.png"), imageBytes);
  const messages = [{ id: "original", role: "user", text: "根据图和文件回答", attachments: [
    { id: "file", name: "evidence.txt", path: path.join(directory, "evidence.txt") },
    { id: "image", name: "evidence.png", path: path.join(directory, "evidence.png"), mimeType: "image/png" }
  ] }];
  const db = { sessions: [{ id: "source" }, { id: "destination" }], messages: { destination: [] }, settings: {} };
  const calls = [];
  const source = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const noOp = () => {};
  const harness = vm.createContext({
    prepareQuotedInput, randomUUID: () => "test", loadDb: () => db,
    loadMessagesForSession: async (id) => id === "source" ? messages : [],
    enrichAttachments: (items) => Promise.all(items.map((item) => enrichAttachmentContent(item, { resolvePath: (attachment) => attachment.path }))),
    activeRuns: new Map(), console: { info: noOp, log: noOp, error: (...args) => { throw new Error(args.join(" ")); } },
    conversationCapabilityContext: () => ({}), normalizeHmsPresentationResult: (value) => value,
    runWasTimedOut: () => false, runWasAbortedByUser: () => false,
    ensureConversationTraceLogger: () => ({ start: noOp, finish: noOp, understood: noOp, route: noOp }),
    isContinuationRequest: () => false,
    ensureTaskBrain: () => ({ getAwaitingConfirmation: () => null }),
    blackBallOwnedUnderstanding: () => ({ shouldCreateTask: false, responseMode: "answer", semanticOwner: "black_ball" }),
    persistSessionModelConstraints: noOp, ensureResponseRouter: () => ({ clearClarification: noOp }),
    routeNonExecutionResponse: (request) => request.answer(),
    conversationResultStatus: () => "completed", verifiedDelegationResponse: () => false,
    updateSession: noOp, isInternalRuntimeFailure: () => false,
    delegationExpectedFor: () => false, knowledgeReferencesForMessage: () => ({ references: [] }),
    classifyBaiqiuDialogMode: () => "chat", ensureRunActive: noOp,
    timingForTask: () => ({}),
    runHermesSessionPromptWithRecovery: async (session, prompt, attachments) => {
      calls.push({ session, prompt, attachments });
      return { status: "completed", text: "模型回复占位" };
    }
  });
  const runtime = source.slice(source.indexOf("async function productLayerChatRuntime("), source.indexOf("function bindUnderstandingToTaskDecision("));
  const submit = source.slice(source.indexOf("async function submitProductWithTaskBrain("), source.indexOf("function ensureProductExecutionRouter("));
  vm.runInContext(runtime + "\n" + submit, harness);
  harness.productLayerConversationReply = (input) => harness.productLayerChatRuntime({ ...input, skipPersist: true });
  const result = await harness.submitProductWithTaskBrain({ sessionId: "destination", message: "解释这个", attachments: [], quote: { sessionId: "source", messageId: "original" } });
  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].session.id, "destination");
  assert.match(calls[0].prompt, /根据图和文件回答/);
  assert.match(calls[0].attachments[0].textContent, /真正的附件正文：蓝色按钮/);
  assert.equal(calls[0].attachments[1].dataUrl, `data:image/png;base64,${imageBytes.toString("base64")}`);
  assert.deepEqual(db.messages.destination, []);
});

test("uses the renderer fallback when the original message was removed", () => {
  const quote = resolveQuoteContext({
    messages: [],
    quote: {
      messageId: "missing",
      text: "原消息已经不在当前窗口",
      attachments: [{ id: "fallback", name: "原图.png", mimeType: "image/png", path: "D:/原图.png" }]
    },
    sessionId: "s1"
  });

  assert.equal(quote.messageId, "missing");
  assert.equal(quote.text, "原消息已经不在当前窗口");
  assert.equal(quote.attachments[0].path, "D:/原图.png");
});

test("deduplicates the same quoted attachment before model submission", () => {
  const merged = mergeQuoteAttachments(
    [{ id: "same", name: "报告.pdf", path: "D:/报告.pdf" }],
    [{ id: "same", name: "报告.pdf", path: "D:/报告.pdf" }, { id: "other", name: "图.png", path: "D:/图.png" }]
  );
  assert.deepEqual(merged.map((item) => item.name), ["报告.pdf", "图.png"]);
});
