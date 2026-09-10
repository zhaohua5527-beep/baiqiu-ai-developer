"use strict";

const assert = require("node:assert/strict");

const debugPort = Number(process.env.BAIQIU_DEBUG_PORT || 9226);
const timeoutMs = Number(process.env.BAIQIU_REAL_TEST_TIMEOUT_MS || 180_000);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data || "{}"));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "CDP request failed"));
      else pending.resolve(message.result || {});
    });
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    await this.call("Runtime.enable");
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "renderer evaluation failed");
    }
    return response.result?.value;
  }

  close() {
    try { this.socket?.close(); } catch {}
  }
}

async function rendererTarget() {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
  if (!response.ok) throw new Error(`无法连接开发者版调试端口 ${debugPort}`);
  const targets = await response.json();
  const target = targets.find((item) => item.type === "page" && /renderer-v2[\\/]index\.html/i.test(item.url));
  if (!target?.webSocketDebuggerUrl) throw new Error("没有找到开发者版渲染页面");
  return target;
}

function publicEvent(event = {}) {
  return {
    eventId: String(event.eventId || ""),
    target: String(event.target || ""),
    type: String(event.type || event.kind || ""),
    sequence: Number(event.turnSequence || event.sequence || 0),
    segmentId: String(event.segmentId || ""),
    provenance: String(event.provenance || ""),
    message: String(event.message ?? event.delta ?? event.text ?? "").slice(0, 240)
  };
}

async function main() {
  const target = await rendererTarget();
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  try {
    const ready = await cdp.evaluate(`Boolean(
      document.readyState === "complete"
      && window.heiqiu
      && document.querySelector("#chatInput")
      && !document.querySelector(".fatal-error-overlay")
    )`);
    assert.equal(ready, true, "开发者版界面未就绪");

    if (process.argv.includes("--inspect")) {
      const requestedSession = process.argv.find((value) => value.startsWith("--session="))?.slice("--session=".length);
      if (requestedSession) {
        await cdp.evaluate(`(async () => {
          await window.heiqiu.selectSession(${JSON.stringify(String(requestedSession))});
          state.db = await window.heiqiu.init();
          state.selectedSessionId = ${JSON.stringify(String(requestedSession))};
          await renderAll({ refreshSettings: false, refreshSecondary: false });
        })()`);
      }
      const diagnostic = await cdp.evaluate(`(() => ({
        selectedSessionId: state.selectedSessionId,
        sessions: (state.db?.sessions || []).map((session) => ({ id: session.id, status: session.status, title: session.title })),
        messages: (state.currentMessages || []).slice(-6).map((message) => ({
          role: message.role,
          id: message.id,
          text: String(message.text || "").slice(0, 160),
          status: message.raw?.productResult?.status || message.status || "",
          executionCount: Array.isArray(message.raw?.productResult?.executionLog) ? message.raw.productResult.executionLog.length : 0,
          structuredCount: Array.isArray(message.raw?.productResult?.structuredEvents) ? message.raw.productResult.structuredEvents.length : 0,
          answerCount: Array.isArray(message.raw?.productResult?.answerSegments) ? message.raw.productResult.answerSegments.length : 0,
          toolProtocol: message.raw?.productResult?.baiqiuToolProtocol || null,
          toolCalls: Array.isArray(message.raw?.productResult?.toolCalls)
            ? message.raw.productResult.toolCalls.map((call) => ({ id: String(call.toolCallId || ""), title: String(call.title || ""), status: String(call.status || "") }))
            : [],
          stopReason: String(message.raw?.productResult?.stopReason || ""),
          deliveryStatus: String(message.raw?.productResult?.deliveryStatus || "")
        })),
        streams: [...liveChatStreams.values()].map((entry) => ({
          sessionId: entry.sessionId,
          turnId: entry.turnId,
          state: entry.turnState,
          terminalType: entry.terminalType || "",
          executionCount: entry.activityDetails?.length || 0,
          structuredCount: entry.structuredEvents?.length || 0,
          answerCount: entry.answerSegments?.length || 0,
          answerText: entry.answerSegments?.map((segment) => String(segment?.text || segment?.delta || "")).join("").slice(0, 1000),
          execution: (entry.activityDetails || []).map((event) => ({ eventId: String(event?.eventId || ""), target: String(event?.target || ""), type: String(event?.type || event?.kind || ""), sequence: Number(event?.turnSequence || event?.sequence || 0), message: String(event?.message || event?.delta || event?.text || "").slice(0, 240) })),
          structured: (entry.structuredEvents || []).map((event) => ({ eventId: String(event?.eventId || ""), target: String(event?.target || ""), type: String(event?.type || event?.kind || ""), sequence: Number(event?.turnSequence || event?.sequence || 0), message: String(event?.message || event?.delta || event?.text || "").slice(0, 240) }))
        })),
        busy: Boolean(state.busy),
        activeSendOwners: [...activeSendOwners.entries()].map(([sessionId, streamId]) => ({ sessionId, streamId })),
        queueActive: (state.db?.sessions || []).filter((session) => sessionTaskQueue.isActive(session.id)).map((session) => session.id),
        fatal: document.querySelector(".fatal-error-overlay")?.innerText || "",
        inputDisabled: Boolean(document.querySelector("#chatInput")?.disabled)
      }))()`);
      diagnostic.runtime = await cdp.evaluate(`window.heiqiu?.modelRuntimeState?.().then((runtime) => ({
        keys: Object.keys(runtime || {}).sort(),
        configured: Boolean(runtime?.configured),
        ready: Boolean(runtime?.ready),
        state: String(runtime?.state || ""),
        runtime: String(runtime?.runtime || ""),
        error: String(runtime?.error || runtime?.message || "").slice(0, 500)
      })).catch((error) => ({ error: String(error?.message || error).slice(0, 500) }))`);
      diagnostic.readiness = await cdp.evaluate(`window.heiqiu?.modelReadiness?.().then((readiness) => ({
        keys: Object.keys(readiness || {}).sort(),
        configured: Boolean(readiness?.configured),
        providerId: String(readiness?.providerId || ""),
        missing: Array.isArray(readiness?.missing) ? readiness.missing.map((item) => String(item)) : [],
        verified: Boolean(readiness?.verified),
        enabled: Boolean(readiness?.enabled),
        model: String(readiness?.model || "")
      })).catch((error) => ({ error: String(error?.message || error).slice(0, 500) }))`);
      diagnostic.selectedSession = await cdp.evaluate(`(() => {
        const session = (state.db?.sessions || []).find((item) => item.id === state.selectedSessionId) || {};
        return {
          id: String(session.id || ""),
          status: String(session.status || ""),
          activeTaskId: String(session.activeTaskId || ""),
          lastExecution: session.lastExecution && typeof session.lastExecution === "object" ? {
            taskId: String(session.lastExecution.taskId || ""),
            status: String(session.lastExecution.status || ""),
            deliveryStatus: String(session.lastExecution.deliveryStatus || ""),
            persistenceError: String(session.lastExecution.persistenceError || ""),
            error: String(session.lastExecution.error || "").slice(0, 500)
          } : null,
          queue: (state.db?.queue || []).filter((task) => task.sessionId === state.selectedSessionId).slice(-3).map((task) => ({
            id: String(task.id || task.taskId || ""),
            status: String(task.status || ""),
            error: String(task.error || "").slice(0, 500)
          }))
        };
      })()`);
      process.stdout.write(`${JSON.stringify(diagnostic, null, 2)}\n`);
      return;
    }

    const previousSessionId = await cdp.evaluate(`(() => {
      const previous = state.selectedSessionId;
      document.querySelector("#newSessionBtn")?.click();
      return previous;
    })()`);
    let sessionId = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      sessionId = await cdp.evaluate("state.selectedSessionId || ''");
      if (sessionId && sessionId !== previousSessionId) break;
      await delay(100);
    }
    assert.ok(sessionId && sessionId !== previousSessionId, "新开发者测试会话未完成创建");

    await cdp.evaluate(`(() => {
      const original = window.heiqiu?.productSubmitTask;
      if (typeof original !== "function" || original.__realEventCollectorWrapped) return;
      const wrapped = async (...args) => {
        try {
          const result = await original(...args);
          window.__realBlackBallLastProductResult = {
            kind: "result",
            keys: Object.keys(result || {}).sort(),
            success: result?.success === true,
            status: String(result?.status || ""),
            deliveryStatus: String(result?.deliveryStatus || ""),
            presentationStatus: String(result?.presentationStatus || ""),
            error: String(result?.error || "").slice(0, 500),
            textLength: String(result?.text || "").length,
            executionCount: Array.isArray(result?.executionLog) ? result.executionLog.length : 0,
            structuredCount: Array.isArray(result?.structuredEvents) ? result.structuredEvents.length : 0,
            answerCount: Array.isArray(result?.answerSegments) ? result.answerSegments.length : 0
          };
          return result;
        } catch (error) {
          window.__realBlackBallLastProductResult = {
            kind: "error",
            error: String(error?.message || error).slice(0, 500)
          };
          throw error;
        }
      };
      wrapped.__realEventCollectorWrapped = true;
      window.heiqiu.productSubmitTask = wrapped;
    })()`);

    await cdp.evaluate(`(() => {
      window.__realBlackBallCurrentStepObserver?.observer?.disconnect?.();
      const record = { seen: false, textSeen: false, maxEntries: 0 };
      const sample = () => {
        const entries = [...document.querySelectorAll(".execution-event-narrative .execution-event-narrative-entry")]
          .filter((node) => node.isConnected && !node.hidden);
        if (entries.length) record.seen = true;
        if (entries.some((node) => node.textContent.trim())) record.textSeen = true;
        record.maxEntries = Math.max(record.maxEntries, entries.length);
      };
      const observer = new MutationObserver(sample);
      observer.observe(document.body, { childList: true, characterData: true, subtree: true });
      sample();
      window.__realBlackBallCurrentStepObserver = { record, observer };
    })()`);

    const start = await cdp.evaluate(`(() => {
      const sessionId = state.selectedSessionId;
      const beforeCount = (state.currentMessages || []).length;
      const input = document.querySelector("#chatInput");
      input.value = "请使用可用工具读取当前工作区的 package.json，并报告其中的 name 与 version。仅报告你实际执行过的步骤；请在每个真实执行阶段及时发送公开进度事件，不要编造进度。";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#chatForm").requestSubmit();
      return { sessionId, beforeCount, startedAt: Date.now() };
    })()`);

    const firstSeenAt = new Map();
    const liveWitness = {
      activitySeen: false,
      theaterSeen: false,
      visibleProcessRows: 0,
      typingSeen: false,
      eventClockSeen: false,
      unclippedEventTextSeen: false,
      currentStepSeen: false,
      maxCurrentStepEntries: 0
    };
    let latest = null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      latest = await cdp.evaluate(`(async () => {
        const messagePage = await window.heiqiu.messages(${JSON.stringify(start.sessionId)}, { limit: 100 });
        const messages = Array.isArray(messagePage) ? messagePage : (messagePage?.messages || []);
        const active = [...liveChatStreams.values()].find((entry) => entry.sessionId === ${JSON.stringify(start.sessionId)});
        const liveEvents = active ? [
          ...(active.activityDetails || []),
          ...(active.structuredEvents || [])
        ] : [];
        const completed = messages.filter((message) => message.role === "assistant" && String(
          message.raw?.productResult?.clientMessageId || message.raw?.clientMessageId || ""
        ) === ${JSON.stringify(start.userMessageId || "")}).at(-1)
          || messages.filter((message) => message.role === "assistant").at(-1);
        const product = completed?.raw?.productResult || {};
        const eventsFrom = (key) => {
          for (const source of [product, completed?.raw, product.raw]) {
            if (Array.isArray(source?.[key])) return source[key];
          }
          return [];
        };
        return {
          live: liveEvents,
          completed: completed ? {
            id: String(completed.id || ""),
            status: product.status || completed.status || "",
            deliveryStatus: product.deliveryStatus || "",
            text: String(completed.text || "").slice(0, 1000),
            execution: eventsFrom("executionLog"),
            structured: eventsFrom("structuredEvents"),
            answers: eventsFrom("answerSegments")
          } : null,
          row: [...document.querySelectorAll(".message.assistant")]
            .filter((row) => row.dataset.messageId === String(completed?.id || ""))
            .map((row) => ({
              toggle: Boolean(row.querySelector(".execution-activity-toggle")),
              hiddenDetails: [...row.querySelectorAll(".stream-segment-process, .stream-segment-structured, .stream-segment-reasoning")]
                .filter((node) => node.textContent.trim()).every((node) => node.hidden),
              finalVisible: Boolean(row.querySelector(".stream-segment-answer, .rendered"))
            }))[0] || null,
          liveSurface: active ? (() => {
            const activity = document.querySelector(".streaming-activity:not(.execution-activity-completed)");
            const visibleProcessRows = [...(activity?.querySelectorAll(".execution-activity-details .execution-activity-line") || [])]
              .filter((node) => !node.hidden && node.textContent.trim()).length;
            const eventText = activity?.querySelector(".execution-activity-line-text");
            const eventTextStyle = eventText ? getComputedStyle(eventText) : null;
            const currentStepEntries = [...(activity?.querySelectorAll(".execution-event-narrative .execution-event-narrative-entry") || [])]
              .filter((node) => !node.hidden && node.textContent.trim()).length;
            return {
              activity: Boolean(activity),
              theater: Boolean(activity?.querySelector(".streaming-activity-label[data-theater='1']")),
              visibleProcessRows,
              typing: Boolean(activity?.__executionActivityFlow?.activeLabel),
              eventClock: Boolean(activity?.querySelector(".execution-activity-line time, .execution-activity-line-time")),
              unclippedEventText: Boolean(eventTextStyle
                && eventTextStyle.whiteSpace !== "nowrap"
                && eventTextStyle.overflow === "visible"
                && eventTextStyle.textOverflow === "clip"),
              currentStepEntries
            };
          })() : null,
          currentStepObserver: window.__realBlackBallCurrentStepObserver?.record || null,
          productSubmitResult: window.__realBlackBallLastProductResult || null
        };
      })()`);

      if (latest.liveSurface?.activity) liveWitness.activitySeen = true;
      if (latest.liveSurface?.theater) liveWitness.theaterSeen = true;
      if (latest.liveSurface?.typing) liveWitness.typingSeen = true;
      if (latest.liveSurface?.eventClock) liveWitness.eventClockSeen = true;
      if (latest.liveSurface?.unclippedEventText) liveWitness.unclippedEventTextSeen = true;
      if (latest.liveSurface?.currentStepEntries) liveWitness.currentStepSeen = true;
      if (latest.currentStepObserver?.seen) liveWitness.currentStepSeen = true;
      liveWitness.visibleProcessRows = Math.max(liveWitness.visibleProcessRows, Number(latest.liveSurface?.visibleProcessRows || 0));
      liveWitness.maxCurrentStepEntries = Math.max(liveWitness.maxCurrentStepEntries, Number(latest.liveSurface?.currentStepEntries || 0));
      liveWitness.maxCurrentStepEntries = Math.max(liveWitness.maxCurrentStepEntries, Number(latest.currentStepObserver?.maxEntries || 0));

      for (const event of [...(latest.live || []), ...(latest.completed?.execution || []), ...(latest.completed?.structured || [])]) {
        const normalized = publicEvent(event);
        if (normalized.eventId && !firstSeenAt.has(normalized.eventId)) firstSeenAt.set(normalized.eventId, Date.now() - start.startedAt);
      }
      if (latest.completed && ["delivered", "completed", "failed", "cancelled"].includes(String(latest.completed.deliveryStatus || latest.completed.status).toLowerCase())) break;
      await delay(100);
    }

    if (!latest?.completed) {
      throw new Error(`真实黑球任务未在时限内产生最终结果；IPC=${JSON.stringify(latest?.productSubmitResult || null)}`);
    }
    latest.row = await cdp.evaluate(`(async () => {
      await window.heiqiu.selectSession(${JSON.stringify(start.sessionId)});
      state.db = await window.heiqiu.init();
      state.selectedSessionId = ${JSON.stringify(start.sessionId)};
      await renderAll({ refreshSettings: false, refreshSecondary: false });
      const row = [...document.querySelectorAll(".message.assistant")]
        .filter((node) => node.dataset.messageId === String(${JSON.stringify(latest.completed.id || "")}))
        .at(-1);
      return row ? {
        toggle: Boolean(row.querySelector(".execution-activity-toggle")),
        theater: Boolean(row.querySelector(".streaming-activity-label[data-theater='1']")),
        currentStep: Boolean(row.querySelector(".execution-event-narrative .execution-event-narrative-entry")),
        hiddenDetails: [...row.querySelectorAll(".stream-segment-process, .stream-segment-structured, .stream-segment-reasoning")]
          .filter((node) => node.textContent.trim()).every((node) => node.hidden),
        finalVisible: Boolean(row.querySelector(".stream-segment-answer, .rendered"))
      } : null;
    })()`);
    const execution = latest.completed.execution.map(publicEvent);
    const structured = latest.completed.structured.map(publicEvent);
    const answer = latest.completed.answers.map(publicEvent);
    const timeline = [...execution, ...structured, ...answer]
      .sort((a, b) => a.sequence - b.sequence || a.eventId.localeCompare(b.eventId))
      .map((event) => ({ ...event, firstSeenMs: firstSeenAt.get(event.eventId) ?? null }));

    assert.ok(execution.length > 0, "真实黑球任务未发送执行事件");
    assert.ok(structured.length > 0, "真实黑球任务未发送公开阶段事件");
    assert.ok(answer.length > 0, "真实黑球任务未发送答案事件");
    assert.equal(liveWitness.activitySeen, true, "真实执行期未出现活动时间轴");
    assert.equal(liveWitness.theaterSeen, true, "真实执行期未出现一排小剧场");
    assert.ok(liveWitness.visibleProcessRows > 0, "真实执行期未显示黑球事件");
    assert.ok(liveWitness.visibleProcessRows <= 3, "真实执行期超过三排过程显示上限");
    assert.equal(liveWitness.typingSeen, true, "真实执行期未观察到事件打字机动画");
    assert.equal(liveWitness.eventClockSeen, false, "真实执行事件仍显示了独立时间戳");
    assert.equal(liveWitness.unclippedEventTextSeen, true, "真实执行事件文本仍被单行省略显示");
    assert.equal(liveWitness.currentStepSeen, true, "真实执行期未显示当前公开任务步骤");
    assert.equal(liveWitness.maxCurrentStepEntries, 1, "真实执行期累计显示了多个任务步骤");
    assert.equal(latest.row?.toggle, true, "完成态缺少时间轴展开入口");
    assert.equal(latest.row?.theater, false, "完成态仍显示小剧场文字");
    assert.equal(latest.row?.currentStep, false, "完成态仍显示当前任务步骤");
    assert.equal(latest.row?.hiddenDetails, true, "完成态仍显示了阶段详情");
    await cdp.evaluate(`window.__realBlackBallCurrentStepObserver?.observer?.disconnect?.()`);

    const toggleState = await cdp.evaluate(`(async () => {
      const row = [...document.querySelectorAll(".message.assistant")]
        .filter((node) => node.dataset.messageId === ${JSON.stringify(latest.completed.id)})
        .at(-1);
      const toggle = row?.querySelector(".execution-activity-toggle");
      if (!row || !toggle) return null;
      const rendered = row.querySelector(":scope > .bubble > .rendered");
      const details = () => [...row.querySelectorAll(".stream-segment-process, .stream-segment-structured, .stream-segment-reasoning")]
        .filter((node) => node.textContent.trim());
      const activity = toggle.closest(".streaming-activity, .thinking-message");
      const beforeResult = Boolean(activity && rendered && (activity.compareDocumentPosition(rendered) & Node.DOCUMENT_POSITION_FOLLOWING));
      toggle.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const expanded = details().length > 0 && details().every((node) => !node.hidden);
      toggle.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { beforeResult, expanded, collapsed: details().every((node) => node.hidden) };
    })()`);
    assert.equal(toggleState?.beforeResult, true, "时间轴没有位于最终结果之前");
    assert.equal(toggleState?.expanded, true, "Timeline toggle did not expand real stage details");
    assert.equal(toggleState?.collapsed, true, "Timeline toggle did not hide stage details again");

    process.stdout.write(`${JSON.stringify({
      outcome: String(latest.completed.deliveryStatus || latest.completed.status),
      response: latest.completed.text,
      executionCount: execution.length,
        structuredCount: structured.length,
        answerCount: answer.length,
        liveWitness,
        toggleState,
        timeline
    }, null, 2)}\n`);
  } finally {
    cdp.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
