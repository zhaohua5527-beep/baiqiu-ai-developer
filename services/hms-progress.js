"use strict";

const path = require("node:path");

const SECRET_PATTERNS = [
  /\bsk-[a-z0-9_-]{8,}\b/gi,
  /\b(api[_\s-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi
];

const PROGRESS_OPEN_TAG = "<baiqiu-progress>";
const PROGRESS_CLOSE_TAG = "</baiqiu-progress>";
const ANSWER_OPEN_PREFIX = "<baiqiu-answer";
const ANSWER_CLOSE_TAG = "</baiqiu-answer>";
const FINAL_OPEN_TAG = "<baiqiu-final>";
const FINAL_CLOSE_TAG = "</baiqiu-final>";

function normalizeEscapedHmsProtocolClosers(value = "") {
  return String(value || "").replace(
    /<\\+\/(baiqiu-(?:progress|answer|final|presentation|outcome|clarification|outline))\b/gi,
    "</$1"
  );
}

function publicText(value = "", maxLength = 600) {
  let text = String(value || "")
    .replace(/<\/?baiqiu-(?:presentation|outcome|clarification|outline|answer|final)(?:\s+[^>]*)?>/gi, "")
    .replace(/\[(?:Runtime context|System prompt|White Ball tool result)\]/gi, "")
    .replace(/Hermes\s+Agent|\bHMS\b|Hermes|OpenClaw/gi, "黑球")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  text = text.replace(SECRET_PATTERNS[0], "[已隐藏密钥]");
  text = text.replace(SECRET_PATTERNS[1], "$1=[已隐藏]");
  return text.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

// Preserve provider chunk boundaries and whitespace so the renderer can show
// reasoning at the cadence produced by the model instead of replaying it.
function publicReasoningDelta(value = "", maxLength = 1200) {
  // Keep the provider's chunk boundaries and whitespace. This is a transport
  // safety pass only; White Ball must not rewrite or summarize Black Ball's
  // public reasoning.
  let text = String(value || "")
    .replace(/<\/?baiqiu-(?:progress|presentation|outcome|clarification|outline|answer|final)(?:\s+[^>]*)?>/gi, "")
    .replace(/\[(?:Runtime context|System prompt|White Ball tool result)\]/gi, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  text = text.replace(SECRET_PATTERNS[0], "[已隐藏密钥]");
  text = text.replace(SECRET_PATTERNS[1], "$1=[已隐藏]");
  return text.slice(0, Math.max(1, Number(maxLength) || 1200));
}

function isConcretePublicReasoning(value = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return false;
  // Public reasoning is allowed only when it carries a concrete observation
  // or decision. These generic self-narration templates are not execution
  // evidence and must never become the visible thinking layer.
  const genericTemplates = [
    /^\u5f53\u524d(?:\u8bf7\u6c42|\u95ee\u9898).{0,24}(?:\u7b80\u5355\u95ee\u5019|\u95ee\u5019).{0,32}(?:\u56e0\u6b64|\u6240\u4ee5).{0,24}(?:\u76f4\u63a5|\u7b80\u6d01).{0,24}(?:\u56de\u5e94|\u56de\u7b54)/,
    /^(?:\u6211\u5c06|\u6211\u4f1a|\u63a5\u4e0b\u6765).{0,24}(?:\u5206\u6790|\u5904\u7406|\u56de\u7b54|\u601d\u8003)/,
    /^(?:according to|based on)\s+(?:my|the)\s+(?:instructions|request)/i
  ];
  return !genericTemplates.some((pattern) => pattern.test(text));
}

// Public progress may identify the runtime internally. Keep that provenance in
// the task board payload, but use neutral wording in the compact chat status.
function publicActivityText(value = "", maxLength = 180) {
  return publicText(value, maxLength)
    .replace(/(?:\u9ed1\u7403|\u767d\u7403)/g, "")
    .replace(/\b(?:HMS|Hermes|CEO|Worker|Agent)\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/^\s*[：:]\s*/, "")
    .trim()
    .slice(0, maxLength);
}

function publicCommandSummary(value = "", maxLength = 96) {
  let text = String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(SECRET_PATTERNS[0], "[已隐藏密钥]")
    .replace(SECRET_PATTERNS[1], "$1=[已隐藏]");
  return text
    .replace(/(?:--?(?:api[_-]?key|token|password|secret)|\/+(?:api[_-]?key|token|password|secret))\s+(?:"[^"]*"|'[^']*'|\S+)/gi, "$1 [已隐藏]")
    .replace(/\b(?:set|export)\s+(?:api[_-]?key|token|password|secret)\s*=\s*[^\s;]+/gi, "$1 [已隐藏]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function contentText(update = {}) {
  const content = update.content;
  if (content?.type === "text") return String(content.text || "");
  if (content?.type === "thinking") return String(content.thinking || content.text || "");
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      return item.text || item.thinking || item.reasoning_content || item.reasoning || "";
    }).join("");
  }
  return String(
    update.text
      || update.delta
      || update.message
      || update.thought
      || update.reasoningContent
      || update.reasoning_content
      || update.reasoning
      || ""
  );
}

function progressEvents(value = {}) {
  const payload = value && typeof value === "object" ? value : {};
  const action = publicText(payload.stage || payload.action || "execute", 32) || "execute";
  const status = publicText(payload.status || "running", 24) || "running";
  const segmentId = String(payload.segmentId || payload.segment_id || "").trim().slice(0, 64);
  // This envelope carries a model-authored public reasoning summary. The
  // old implementation synthesized a repeated "已完成/判断/下一步" sentence
  // from three fields, which made every turn look identical and obscured the
  // actual update. Keep the authored message as-is and leave milestone fields
  // as transport metadata instead of presenting them as reasoning.
  const message = publicReasoningDelta(payload.message || payload.summary || "", 20000).trim();
  if (!isConcretePublicReasoning(message)) return [];
  return [{
    source: "hms",
    actor: "model",
    provenance: "blackball_public",
    kind: "public_reasoning",
    action,
    status,
    track: "public_reasoning",
    message,
    ...(payload.completed ? { completed: publicText(payload.completed, 240) } : {}),
    ...(payload.next ? { next: publicText(payload.next, 240) } : {}),
    ...(segmentId ? { segmentId } : {})
  }];
}

function parseProgressEnvelope(value = "") {
  try {
    return progressEvents(JSON.parse(String(value || "").trim()));
  } catch {
    return [];
  }
}

function partialTagLength(value = "", tag = PROGRESS_OPEN_TAG) {
  const text = String(value || "");
  const lower = text.toLowerCase();
  const target = tag.toLowerCase();
  const limit = Math.min(lower.length, target.length - 1);
  for (let length = limit; length > 0; length -= 1) {
    if (lower.endsWith(target.slice(0, length))) return length;
  }
  return 0;
}

function partialAnswerOpenLength(value = "") {
  const text = String(value || "");
  const lower = text.toLowerCase();
  const start = lower.lastIndexOf(ANSWER_OPEN_PREFIX);
  if (start < 0 || lower.indexOf(">", start) >= 0) return 0;
  return text.length - start;
}

function partialProtocolSuffixLength(value = "") {
  const text = String(value || "");
  const lower = text.toLowerCase();
  const escapedClosers = [PROGRESS_CLOSE_TAG, ANSWER_CLOSE_TAG, FINAL_CLOSE_TAG]
    .map((tag) => tag.replace("</", "<\\/"));
  let keep = Math.max(
    partialTagLength(text, PROGRESS_OPEN_TAG),
    partialTagLength(text, PROGRESS_CLOSE_TAG),
    partialTagLength(text, ANSWER_OPEN_PREFIX),
    partialAnswerOpenLength(text),
    partialTagLength(text, ANSWER_CLOSE_TAG),
    partialTagLength(text, FINAL_OPEN_TAG),
    partialTagLength(text, FINAL_CLOSE_TAG),
    ...escapedClosers.map((tag) => partialTagLength(text, tag))
  );
  const protocolStart = Math.max(lower.lastIndexOf("<baiqiu-"), lower.lastIndexOf("</baiqiu-"));
  if (protocolStart >= 0 && lower.indexOf(">", protocolStart) < 0) {
    keep = Math.max(keep, text.length - protocolStart);
  }
  return keep;
}

function stripTrailingPartialHmsProtocol(value = "") {
  const source = normalizeEscapedHmsProtocolClosers(value);
  const start = source.lastIndexOf("<");
  if (start < 0) return source;
  const candidate = source.slice(start);
  if (candidate.includes(">")) return source;
  const lower = candidate.toLowerCase();
  if (!/^<\/?baiqiu-/i.test(candidate)) return source;
  const boundaries = [
    "<baiqiu-progress", "</baiqiu-progress",
    "<baiqiu-answer", "</baiqiu-answer",
    "<baiqiu-final", "</baiqiu-final",
    "<baiqiu-presentation", "</baiqiu-presentation",
    "<baiqiu-outcome", "</baiqiu-outcome",
    "<baiqiu-clarification", "</baiqiu-clarification",
    "<baiqiu-outline", "</baiqiu-outline"
  ];
  const recognized = boundaries.some((boundary) => boundary.startsWith(lower) || lower.startsWith(boundary));
  return recognized ? source.slice(0, start) : source;
}

function answerOpenMatch(value = "") {
  return /<baiqiu-answer\b[^>]*>/i.exec(String(value || ""));
}

// Some providers occasionally emit a closing progress tag where the next
// answer opening tag should be (for example, `</baiqiu-answer segmentId="1">`).
// Keep this recovery deliberately narrow: only an answer-shaped tag carrying a
// segment id is promoted to an opening boundary. A plain `</baiqiu-answer>` is
// still treated as a malformed progress close, never as an answer start.
function malformedAnswerOpenMatch(value = "") {
  return /<\/baiqiu-answer\b[^>]*\bsegment(?:Id|_id)\s*=\s*["'][^"']+["'][^>]*>/i.exec(String(value || ""));
}

function malformedProgressCloseMatch(value = "") {
  return /<\/baiqiu-progress(?=[^\s>])/i.exec(String(value || ""));
}

function partialProtocolBoundary(value = "") {
  const lower = String(value || "").toLowerCase();
  if (!lower) return false;
  return [PROGRESS_OPEN_TAG, ANSWER_OPEN_PREFIX, ANSWER_CLOSE_TAG, FINAL_OPEN_TAG, FINAL_CLOSE_TAG]
    .some((tag) => tag.startsWith(lower));
}

function protocolResidue(value = "") {
  return /<\/?baiqiu-/i.test(String(value || ""));
}

function recognizedStreamProtocolResidue(value = "") {
  return /<\/?baiqiu-(?:progress|answer|final)\b/i.test(String(value || ""));
}

function firstProtocolOpenIndex(value = "") {
  const text = String(value || "");
  const lower = text.toLowerCase();
  const indexes = [
    lower.indexOf(PROGRESS_OPEN_TAG),
    answerOpenMatch(text)?.index ?? -1,
    lower.indexOf(FINAL_OPEN_TAG)
  ].filter((index) => index >= 0);
  return indexes.length ? Math.min(...indexes) : -1;
}

function answerSegmentId(openTag = "", fallback = "") {
  const match = String(openTag || "").match(/\bsegment(?:Id|_id)\s*=\s*["']([^"']+)["']/i);
  return String(match?.[1] || fallback || "").trim().slice(0, 64);
}

function progressEnvelopeSegmentId(value = "") {
  const match = String(value || "").match(/["']segment(?:Id|_id)["']\s*:\s*["']([^"']+)["']/i);
  return String(match?.[1] || "").trim().slice(0, 64);
}

function scopedSegmentId(segmentPrefix = "", value = "", fallback = "") {
  const prefix = String(segmentPrefix || "").trim().slice(0, 120);
  const supplied = String(value || fallback || "").trim();
  if (!supplied) return "";
  if (prefix && supplied.startsWith(prefix)) return supplied.slice(0, 160);
  const localId = supplied.slice(0, 64);
  return prefix ? `${prefix}${localId}`.slice(0, 160) : localId;
}

class HmsMessageStreamDemux {
  constructor({ requireFinalEnvelope = true, segmentPrefix = "" } = {}) {
    this.buffer = "";
    this.requireFinalEnvelope = requireFinalEnvelope !== false;
    this.segmentPrefix = String(segmentPrefix || "").trim().slice(0, 120);
    this.inFinal = false;
    this.finalClosed = false;
    this.inAnswer = false;
    this.currentSegmentId = "";
    this.nextSegmentIndex = 1;
    this.segmentedAnswerSeen = false;
    this.pendingAnswerSegmentId = "";
    this.protocolSeen = false;
    this.protocolMalformed = false;
    this.publicProgressDelta = "";
    this.answerDeltas = [];
    this.completedSegments = [];
    this.streamEvents = [];
  }

  normalizeSegmentId(value = "", fallback = "") {
    return scopedSegmentId(this.segmentPrefix, value, fallback);
  }

  normalizeProgressEvents(events = []) {
    return (Array.isArray(events) ? events : []).map((event) => {
      const segmentId = this.normalizeSegmentId(event?.segmentId || event?.segment_id || "");
      return segmentId ? { ...event, segmentId } : event;
    });
  }

  consume(value = "") {
    this.publicProgressDelta = "";
    this.answerDeltas = [];
    this.completedSegments = [];
    this.streamEvents = [];
    this.buffer += String(value || "");
    this.buffer = normalizeEscapedHmsProtocolClosers(this.buffer);
    if (recognizedStreamProtocolResidue(this.buffer)) this.protocolSeen = true;
    let visibleDelta = "";
    const progressEvents = [];
    while (this.buffer) {
      if (this.pendingAnswerSegmentId) {
        const pendingId = this.pendingAnswerSegmentId;
        const leadingWhitespace = /^\s+/.exec(this.buffer)?.[0] || "";
        if (leadingWhitespace) {
          this.buffer = this.buffer.slice(leadingWhitespace.length);
          if (!this.buffer) break;
          continue;
        }
        const pendingAnswer = answerOpenMatch(this.buffer);
        const lower = this.buffer.toLowerCase();
        if (pendingAnswer?.index === 0) {
          this.buffer = this.buffer.slice(pendingAnswer[0].length);
          this.pendingAnswerSegmentId = "";
          this.inAnswer = true;
          this.segmentedAnswerSeen = true;
          this.currentSegmentId = this.normalizeSegmentId(answerSegmentId(pendingAnswer[0], pendingId));
          this.nextSegmentIndex += 1;
          continue;
        }
        if (lower.startsWith(ANSWER_CLOSE_TAG)) {
          this.buffer = this.buffer.slice(ANSWER_CLOSE_TAG.length);
          this.pendingAnswerSegmentId = "";
          this.completedSegments.push(pendingId);
          this.streamEvents.push({ type: "answer_end", segmentId: pendingId });
          continue;
        }
        if (lower.startsWith(PROGRESS_OPEN_TAG) || lower.startsWith(FINAL_OPEN_TAG)) {
          this.pendingAnswerSegmentId = "";
          continue;
        }
        // An answer opening tag commonly arrives as `<baiqiu-answer ` in one
        // provider chunk and the attributes in the next. Do not promote that
        // incomplete protocol prefix to answer text.
        if (partialProtocolSuffixLength(this.buffer)) break;
        this.pendingAnswerSegmentId = "";
        this.inAnswer = true;
        this.segmentedAnswerSeen = true;
        this.currentSegmentId = pendingId;
        continue;
      }
      if (this.inAnswer) {
        const lower = this.buffer.toLowerCase();
        const closeIndex = lower.indexOf(ANSWER_CLOSE_TAG);
        const nestedOpenIndex = firstProtocolOpenIndex(this.buffer);
        if (nestedOpenIndex >= 0 && (closeIndex < 0 || nestedOpenIndex < closeIndex)) {
          const answerDelta = this.buffer.slice(0, nestedOpenIndex);
          if (answerDelta) {
            this.answerDeltas.push({ segmentId: this.currentSegmentId, delta: answerDelta });
            this.streamEvents.push({ type: "answer_delta", segmentId: this.currentSegmentId, delta: answerDelta });
          }
          this.buffer = this.buffer.slice(nestedOpenIndex);
          this.completedSegments.push(this.currentSegmentId);
          this.streamEvents.push({ type: "answer_end", segmentId: this.currentSegmentId });
          this.currentSegmentId = "";
          this.inAnswer = false;
          continue;
        }
        const malformedProtocol = /<\/?baiqiu-/i.exec(this.buffer);
        if (malformedProtocol && (closeIndex < 0 || malformedProtocol.index < closeIndex)) {
          const answerDelta = this.buffer.slice(0, malformedProtocol.index);
          const malformedTail = this.buffer.slice(malformedProtocol.index);
          const malformedTagEnd = malformedTail.indexOf(">");
          // `<baiqiu-` is also the beginning of every valid protocol tag. Wait
          // for the next provider chunk before deciding that it is malformed;
          // otherwise one real segment emits an early duplicate answer_end.
          if (malformedTagEnd < 0) break;
          if (answerDelta) {
            this.answerDeltas.push({ segmentId: this.currentSegmentId, delta: answerDelta });
            this.streamEvents.push({ type: "answer_delta", segmentId: this.currentSegmentId, delta: answerDelta });
          }
          this.protocolMalformed = true;
          this.completedSegments.push(this.currentSegmentId);
          this.streamEvents.push({ type: "answer_end", segmentId: this.currentSegmentId });
          this.currentSegmentId = "";
          this.inAnswer = false;
          this.buffer = malformedTail.slice(malformedTagEnd + 1);
          continue;
        }
        if (closeIndex < 0) {
          // Preserve every possible protocol suffix, not only a split closing
          // tag. Otherwise the next segment's split opening tag is emitted as
          // permanent answer text before it can be recognized.
          const keep = partialProtocolSuffixLength(this.buffer);
          const answerDelta = this.buffer.slice(0, this.buffer.length - keep);
          if (answerDelta) {
            this.answerDeltas.push({ segmentId: this.currentSegmentId, delta: answerDelta });
            this.streamEvents.push({ type: "answer_delta", segmentId: this.currentSegmentId, delta: answerDelta });
          }
          this.buffer = keep ? this.buffer.slice(-keep) : "";
          break;
        }
        const answerDelta = this.buffer.slice(0, closeIndex);
        if (answerDelta) {
          this.answerDeltas.push({ segmentId: this.currentSegmentId, delta: answerDelta });
          this.streamEvents.push({ type: "answer_delta", segmentId: this.currentSegmentId, delta: answerDelta });
        }
        this.buffer = this.buffer.slice(closeIndex + ANSWER_CLOSE_TAG.length);
        this.completedSegments.push(this.currentSegmentId);
        this.streamEvents.push({ type: "answer_end", segmentId: this.currentSegmentId });
        this.currentSegmentId = "";
        this.inAnswer = false;
        continue;
      }
      if (this.inFinal) {
        const lower = this.buffer.toLowerCase();
        const closeIndex = lower.indexOf(FINAL_CLOSE_TAG);
        if (closeIndex < 0) {
          // Once the explicit final boundary has opened, its content is safe
          // to reveal. Keep only a possible split closing tag between chunks.
          const keep = partialTagLength(this.buffer, FINAL_CLOSE_TAG);
          if (!this.segmentedAnswerSeen) visibleDelta += this.buffer.slice(0, this.buffer.length - keep);
          this.buffer = keep ? this.buffer.slice(-keep) : "";
          break;
        }
        if (!this.segmentedAnswerSeen) visibleDelta += this.buffer.slice(0, closeIndex);
        this.buffer = this.buffer.slice(closeIndex + FINAL_CLOSE_TAG.length);
        this.inFinal = false;
        this.finalClosed = true;
        continue;
      }
      const lower = this.buffer.toLowerCase();
      const progressIndex = lower.indexOf(PROGRESS_OPEN_TAG);
      const answerMatch = answerOpenMatch(this.buffer);
      const answerIndex = answerMatch ? answerMatch.index : -1;
      const finalIndex = lower.indexOf(FINAL_OPEN_TAG);
      const genericProtocolIndexes = [lower.indexOf("<baiqiu-"), lower.indexOf("</baiqiu-")]
        .filter((index) => index >= 0);
      const genericProtocolIndex = genericProtocolIndexes.length ? Math.min(...genericProtocolIndexes) : -1;
      const indexes = [progressIndex, answerIndex, finalIndex, genericProtocolIndex].filter((index) => index >= 0);
      const openIndex = indexes.length ? Math.min(...indexes) : -1;
      if (openIndex < 0) {
        const keep = partialProtocolSuffixLength(this.buffer);
        const plain = this.buffer.slice(0, this.buffer.length - keep);
        if (!this.requireFinalEnvelope && !this.protocolSeen) visibleDelta += plain;
        else if (!this.finalClosed) this.publicProgressDelta += plain;
        this.buffer = keep ? this.buffer.slice(-keep) : "";
        break;
      }
      const plain = this.buffer.slice(0, openIndex);
      if (!this.requireFinalEnvelope && !this.protocolSeen) visibleDelta += plain;
      else if (!this.finalClosed) this.publicProgressDelta += plain;
      if (openIndex === answerIndex) {
        this.protocolSeen = true;
        const openTag = answerMatch[0];
        this.buffer = this.buffer.slice(openIndex + openTag.length);
        this.inAnswer = true;
        this.segmentedAnswerSeen = true;
        this.currentSegmentId = this.normalizeSegmentId(answerSegmentId(openTag, String(this.nextSegmentIndex++)));
        continue;
      }
      if (openIndex === finalIndex) {
        this.protocolSeen = true;
        this.buffer = this.buffer.slice(openIndex + FINAL_OPEN_TAG.length);
        this.inFinal = true;
        continue;
      }
      if (openIndex === genericProtocolIndex && openIndex !== progressIndex) {
        const protocolTail = this.buffer.slice(openIndex);
        const tag = /^<\/?baiqiu-([a-z-]+)\b[^>]*>/i.exec(protocolTail);
        this.protocolSeen = true;
        if (!tag) {
          this.buffer = protocolTail;
          break;
        }
        const name = String(tag[1] || "").toLowerCase();
        const passive = ["presentation", "outcome", "clarification", "outline"].includes(name);
        const closing = /^<\//.test(tag[0]);
        if (!passive || closing) {
          this.protocolMalformed = true;
          this.buffer = protocolTail.slice(tag[0].length);
          continue;
        }
        const passiveClose = `</baiqiu-${name}>`;
        const passiveCloseIndex = protocolTail.toLowerCase().indexOf(passiveClose, tag[0].length);
        if (passiveCloseIndex < 0) {
          this.buffer = protocolTail;
          break;
        }
        this.buffer = protocolTail.slice(passiveCloseIndex + passiveClose.length);
        continue;
      }
      const payloadStart = openIndex + PROGRESS_OPEN_TAG.length;
      this.protocolSeen = true;
      const closeIndex = lower.indexOf(PROGRESS_CLOSE_TAG, payloadStart);

      // Recover a common malformed boundary without waiting for flush(). The
      // answer tag may be either correctly opened or incorrectly written as a
      // closing tag with a segmentId attribute.
      const afterPayload = this.buffer.slice(payloadStart);
      const correctAnswer = answerOpenMatch(afterPayload);
      const malformedAnswer = malformedAnswerOpenMatch(afterPayload);
      const malformedProgressClose = malformedProgressCloseMatch(afterPayload);
      const plainMalformedCloseIndex = lower.indexOf(ANSWER_CLOSE_TAG, payloadStart);
      const boundaries = [
        correctAnswer ? { index: correctAnswer.index, kind: "answer", tag: correctAnswer[0] } : null,
        malformedAnswer ? { index: malformedAnswer.index, kind: "malformed-answer", tag: malformedAnswer[0] } : null,
        malformedProgressClose ? { index: malformedProgressClose.index, kind: "malformed-progress-close", tag: malformedProgressClose[0] } : null,
        plainMalformedCloseIndex >= 0
          ? { index: plainMalformedCloseIndex - payloadStart, kind: "close", tag: ANSWER_CLOSE_TAG }
          : null
      ].filter(Boolean).sort((a, b) => a.index - b.index);
      const recoveryBoundary = boundaries[0];
      const recoveryBoundaryStart = recoveryBoundary
        ? payloadStart + recoveryBoundary.index
        : -1;
      if (recoveryBoundary && (closeIndex < 0 || recoveryBoundaryStart < closeIndex)) {
        const payload = afterPayload.slice(0, recoveryBoundary.index);
          const events = this.normalizeProgressEvents(parseProgressEnvelope(payload));
        if (events.length) {
          progressEvents.push(...events);
          events.forEach((event) => this.streamEvents.push({ type: "progress", progress: event }));
        } else this.protocolMalformed = true;
        const boundaryStart = recoveryBoundaryStart;
        if (recoveryBoundary.kind === "malformed-answer") {
          this.protocolMalformed = true;
          this.buffer = this.buffer.slice(boundaryStart + recoveryBoundary.tag.length);
          this.inAnswer = true;
          this.segmentedAnswerSeen = true;
          this.currentSegmentId = this.normalizeSegmentId(answerSegmentId(recoveryBoundary.tag, String(this.nextSegmentIndex++)));
        } else if (recoveryBoundary.kind === "malformed-progress-close") {
          this.protocolMalformed = true;
          this.buffer = this.buffer.slice(boundaryStart + recoveryBoundary.tag.length);
          this.pendingAnswerSegmentId = String(events[0]?.segmentId || "").trim();
          if (!this.pendingAnswerSegmentId) this.protocolMalformed = true;
        } else if (recoveryBoundary.kind === "answer") {
          this.buffer = this.buffer.slice(boundaryStart);
        } else {
          this.buffer = this.buffer.slice(boundaryStart + recoveryBoundary.tag.length);
        }
        continue;
      }
      if (closeIndex < 0) {
        this.buffer = this.buffer.slice(openIndex);
        break;
      }
      const progressPayload = this.buffer.slice(payloadStart, closeIndex);
      const events = this.normalizeProgressEvents(parseProgressEnvelope(progressPayload));
      if (events.length) {
        progressEvents.push(...events);
        events.forEach((event) => this.streamEvents.push({ type: "progress", progress: event }));
      } else {
        this.protocolMalformed = true;
      }
      // A malformed progress JSON can still retain an unambiguous segment id.
      // Use only that narrow transport field to recover the following answer;
      // the invalid thought payload itself remains quarantined.
      this.pendingAnswerSegmentId = String(
        events[0]?.segmentId || progressEnvelopeSegmentId(progressPayload)
      ).trim();
      if (!this.pendingAnswerSegmentId) this.protocolMalformed = true;
      this.buffer = this.buffer.slice(closeIndex + PROGRESS_CLOSE_TAG.length);
    }
    return {
      visibleDelta: this.segmentedAnswerSeen ? "" : visibleDelta,
      progressEvents,
      publicProgressDelta: this.publicProgressDelta,
      answerDeltas: this.answerDeltas,
      completedSegments: this.completedSegments,
      streamEvents: this.streamEvents,
      protocolError: this.protocolMalformed
    };
  }

  takePublicProgressDelta() {
    const value = this.publicProgressDelta;
    this.publicProgressDelta = "";
    return value;
  }

  flush() {
    this.answerDeltas = [];
    this.completedSegments = [];
    this.streamEvents = [];
    const wasInAnswer = this.inAnswer;
    const value = this.buffer;
    this.buffer = "";
    const withoutPartialProtocol = stripTrailingPartialHmsProtocol(value);
    const trailingProtocolRemoved = withoutPartialProtocol.length !== value.length;
    const residue = protocolResidue(withoutPartialProtocol)
      || partialProtocolBoundary(withoutPartialProtocol)
      || trailingProtocolRemoved;
    if (residue) this.protocolMalformed = true;
    let visibleDelta = !this.requireFinalEnvelope && !this.protocolSeen && !residue ? value : "";
    if (wasInAnswer && value) {
      const answerDelta = withoutPartialProtocol;
      if (answerDelta && !protocolResidue(answerDelta)) {
        this.answerDeltas.push({ segmentId: this.currentSegmentId, delta: answerDelta });
        this.streamEvents.push({ type: "answer_delta", segmentId: this.currentSegmentId, delta: answerDelta });
      } else if (answerDelta) this.protocolMalformed = true;
      visibleDelta = "";
    }
    if (this.requireFinalEnvelope && !wasInAnswer && !this.inFinal && !this.finalClosed && value) {
      this.publicProgressDelta += value;
    }
    this.inFinal = false;
    this.inAnswer = false;
    if (this.segmentedAnswerSeen) visibleDelta = "";
    if (!visibleDelta) {
      return {
        visibleDelta: "",
        progressEvents: [],
        answerDeltas: this.answerDeltas,
        completedSegments: this.completedSegments,
        streamEvents: this.streamEvents,
        protocolError: this.protocolMalformed
      };
    }
    return {
      visibleDelta,
      progressEvents: [],
      answerDeltas: this.answerDeltas,
      completedSegments: this.completedSegments,
      streamEvents: this.streamEvents,
      protocolError: this.protocolMalformed
    };
  }
}

function extractHmsFinalEnvelope(value = "") {
  const source = normalizeEscapedHmsProtocolClosers(value);
  const matches = [...source.matchAll(/<baiqiu-final>([\s\S]*?)<\/baiqiu-final>/gi)];
  if (matches.length !== 1) return null;
  const text = String(matches[0][1] || "").trim();
  if (!text) return null;
  return { text, envelope: matches[0][0] };
}

function stripHmsProgressEnvelopes(value = "") {
  const cleaned = normalizeEscapedHmsProtocolClosers(value)
    .replace(/<baiqiu-progress>[\s\S]*?<\/baiqiu-progress>/gi, "")
    .replace(/<baiqiu-progress>[\s\S]*?<\/baiqiu-answer\b[^>]*>/gi, "")
    .replace(/<baiqiu-progress>[\s\S]*$/gi, "")
    .replace(/<\/?baiqiu-(?:answer|final|presentation|outcome|clarification|outline)\b[^>]*>/gi, "");
  return stripTrailingPartialHmsProtocol(cleaned).trim();
}

function toolDescriptor(update = {}) {
  const toolCall = update.toolCall && typeof update.toolCall === "object" ? update.toolCall : {};
  const rawTitle = publicText(update.title || update.name || toolCall.title || toolCall.name || "工具", 48);
  const normalizedTitle = rawTitle.toLowerCase().replace(/[\s-]+/g, "_");
  const labels = {
    web_search: "联网搜索",
    browser: "浏览器操作",
    browser_open: "浏览器访问",
    read_file: "文件读取",
    write_file: "文件写入",
    create_folder: "文件夹创建",
    write_xlsx: "表格写入",
    spreadsheet: "表格处理",
    terminal: "命令",
    shell: "命令",
    delegate_task: "黑球内部执行委派"
  };
  const label = labels[normalizedTitle]
    || Object.entries(labels).find(([key]) => normalizedTitle.includes(key))?.[1]
    || rawTitle.replace(/[_-]+/g, " ")
    || "工具";
  const rawInput = update.rawInput || update.input || toolCall.rawInput || toolCall.input || {};
  const input = rawInput && typeof rawInput === "object" ? rawInput : {};
  const query = publicText(input.query || input.keyword || input.search || "", 64);
  const targetPath = String(input.path || input.filePath || input.outputPath || "").trim();
  const url = String(input.url || "").trim();
  const commandValue = input.command || input.cmd || input.script || input.commandLine
    || input.shellCommand || input.args || input.argv || (typeof rawInput === "string" ? rawInput : "");
  const command = publicCommandSummary(Array.isArray(commandValue) ? commandValue.join(" ") : commandValue);
  let target = "";
  if (query) target = `“${query}”`;
  else if (targetPath) target = `“${path.basename(targetPath)}”`;
  else if (url) {
    try { target = `“${new URL(url).hostname || publicText(url, 64)}”`; }
    catch { target = `“${publicText(url, 64)}”`; }
  }
  else if (command) target = `“${command}”`;
  return { label, target, command };
}

function toolEvent(update = {}) {
  const { label, target, command } = toolDescriptor(update);
  const toolName = String(update.title || update.name || update.toolCall?.title || update.toolCall?.name || "").toLowerCase();
  const input = update.rawInput || update.input || update.toolCall?.rawInput || update.toolCall?.input || {};
  const targetPath = String(input?.path || input?.filePath || input?.outputPath || "").toLowerCase();
  const displayKind = /(?:terminal|shell|powershell|cmd)/.test(toolName)
    ? "command"
    : /(?:write_file|edit_file|patch)/.test(toolName) && /\.(?:js|ts|jsx|tsx|py|java|go|rs|css|html|json)$/i.test(targetPath)
      ? "code"
      : "tool";
  const status = String(update.status || update.state || "").toLowerCase();
  const toolCallId = String(
    update.toolCallId
      || update.tool_call_id
      || update.toolCall?.toolCallId
      || update.toolCall?.id
      || ""
  ).trim().slice(0, 160);
  const result = update.result && typeof update.result === "object" ? update.result : null;
  const failed = Boolean(update.error) || result?.success === false || ["failed", "error", "cancelled"].includes(status);
  const completed = !failed && (["completed", "complete", "success", "done"].includes(status)
    || (update.sessionUpdate === "tool_call_update" && update.result != null));
  const state = failed ? "failed" : completed ? "completed" : "running";
  const verb = failed ? "失败" : completed ? "已完成" : "正在执行";
  const actionText = displayKind === "command" && command
    ? `${verb}${target}`
    : `${label}${verb}${target ? `：${target}` : ""}`;
  const segmentId = String(update.segmentId || update.segment_id || update.toolCall?.segmentId || "").trim().slice(0, 64);
  return {
    source: "tool",
    actor: "model",
    provenance: "blackball_tool",
    kind: "tool",
    action: "tool",
    status: state,
    ...(toolCallId ? { toolCallId } : {}),
    ...(segmentId ? { segmentId } : {}),
    title: publicText(update.title || update.name || update.toolCall?.title || update.toolCall?.name || label, 80),
    displayKind,
    target: publicText(target, 80),
    message: displayKind === "command" ? actionText : publicActivityText(actionText)
  };
}

function planEvents(update = {}) {
  const entries = Array.isArray(update.entries)
    ? update.entries
    : Array.isArray(update.plan?.entries) ? update.plan.entries : [];
  return entries.map((entry) => {
    const content = publicActivityText(entry?.content || "", 180);
    if (!content) return null;
    const status = String(entry?.status || "pending").toLowerCase();
    const prefix = status === "completed" ? "计划已完成" : status === "in_progress" ? "当前计划" : "后续计划";
    const segmentId = String(entry?.segmentId || entry?.segment_id || update.segmentId || update.segment_id || "").trim().slice(0, 64);
    return {
      source: "hms",
      actor: "model",
      provenance: "blackball_plan",
      kind: "plan",
      action: "plan",
      status,
      ...(segmentId ? { segmentId } : {}),
      message: `${prefix}：${content}`
    };
  }).filter(Boolean);
}

class HmsProgressMapper {
  constructor({ segmentPrefix = "" } = {}) {
    this.segmentPrefix = String(segmentPrefix || "").trim().slice(0, 120);
    this.planStates = new Map();
    this.toolStates = new Map();
    this.messageStream = new HmsMessageStreamDemux({ segmentPrefix: this.segmentPrefix });
    this.thoughtActivitySeen = false;
    this.lastChannel = "";
    this.activeSegmentId = "";
  }

  _attachActiveSegment(events = []) {
    const list = Array.isArray(events) ? events : [];
    return list.map((event) => {
      const explicit = scopedSegmentId(this.segmentPrefix, event?.segmentId || event?.segment_id || "");
      const segmentId = explicit || this.activeSegmentId;
      if (segmentId) this.activeSegmentId = segmentId;
      return segmentId ? { ...event, segmentId } : event;
    });
  }

  consume(update = {}, parsedStream = null) {
    const type = String(update.sessionUpdate || "");
    if (type === "prompt_boundary") {
      this.messageStream = new HmsMessageStreamDemux({ segmentPrefix: this.segmentPrefix });
      this.thoughtActivitySeen = false;
      this.lastChannel = "";
      this.toolStates.clear();
      this.activeSegmentId = "";
      return [];
    }
    const contentType = String(update.content?.type || update.type || "").toLowerCase();
    const reasoningChannel = type === "agent_thought_chunk"
      || /^(?:thinking|reasoning|reasoning_content)$/.test(contentType);
    if (reasoningChannel) {
      this.lastChannel = "thought";
      // Only explicitly public native thoughts may enter chat. Unmarked ACP
      // thought chunks can contain private chain-of-thought; public progress
      // envelopes are still extracted and forwarded as authored.
      const rawText = contentText(update);
      const parsed = parsedStream && typeof parsedStream === "object"
        ? parsedStream
        : this.messageStream.consume(rawText);
      const reasoning = publicReasoningDelta(parsedStream
        ? parsed.publicProgressDelta
        : this.messageStream.takePublicProgressDelta());
      const events = [...parsed.progressEvents];
      if (String(update.visibility || "").toLowerCase() === "public"
        && isConcretePublicReasoning(reasoning)) {
        events.push(this._reasoningDeltaEvent(reasoning, update, this.messageStream.currentSegmentId));
      }
      return this._attachActiveSegment(events);
    }
    if (type === "agent_message_chunk") {
      this.lastChannel = "message";
      const parsed = parsedStream && typeof parsedStream === "object"
        ? parsedStream
        : this.messageStream.consume(contentText(update));
      // Normal message chunks are the answer channel. Do not turn plain
      // answer text into a second synthetic reasoning stream.
      this.messageStream.takePublicProgressDelta();
      return this._attachActiveSegment(parsed.progressEvents);
    }
    if (type === "plan" || type === "plan_update") {
      return this._attachActiveSegment(planEvents(update)).filter((event) => {
        const key = event.message.replace(/^(?:计划已完成|当前计划|后续计划)：/, "");
        if (this.planStates.get(key) === event.status) return false;
        this.planStates.set(key, event.status);
        return true;
      });
    }
    if (type === "tool_call" || type === "tool_call_update") {
      const toolCallId = String(
        update.toolCallId
          || update.tool_call_id
          || update.toolCall?.toolCallId
          || update.toolCall?.id
          || ""
      ).trim().slice(0, 160);
      const previous = toolCallId ? (this.toolStates.get(toolCallId) || {}) : {};
      const mergedTool = {
        ...previous,
        ...update,
        ...(toolCallId ? { toolCallId } : {}),
        toolCall: {
          ...(previous.toolCall && typeof previous.toolCall === "object" ? previous.toolCall : {}),
          ...(update.toolCall && typeof update.toolCall === "object" ? update.toolCall : {})
        }
      };
      if (toolCallId) this.toolStates.set(toolCallId, mergedTool);
      return this._attachActiveSegment([toolEvent(mergedTool)]);
    }
    const rawText = contentText(update);
    if (!rawText) return [];
    this.lastChannel = "unknown";
    return [];
  }

  flush() {
    this.messageStream.flush();
    this.messageStream.takePublicProgressDelta();
    this.thoughtActivitySeen = false;
    // An incomplete envelope or unmarked native thought is not public output.
    // Never promote it merely because the provider stream ended.
    return [];
  }

  _reasoningDeltaEvent(delta, update = {}, segmentId = "") {
    return {
      source: "hms",
      actor: "model",
      provenance: "blackball_public",
      kind: "reasoning_delta",
      action: "analyze",
      status: "running",
      blockIndex: Math.max(0, Number(update.blockIndex ?? update.index ?? 0) || 0),
      ...(String(update.segmentId || segmentId || "").trim()
         ? { segmentId: this._normalizeSegmentId(update.segmentId || segmentId) }
        : {}),
      delta,
      message: delta
    };
  }

  _normalizeSegmentId(value = "") {
    return scopedSegmentId(this.segmentPrefix, value);
  }

}

function buildExecutionLog(updates = [], { runId = "" } = {}) {
  const mapper = new HmsProgressMapper();
  const events = [];
  const seen = new Set();
  const append = (event) => {
    const isTransientReasoning = ["reasoning_delta", "reasoning_note", "public_reasoning"].includes(String(event.kind || "").toLowerCase());
    // Reasoning is a transient UI layer. Keep it out of durable execution
    // history so reopening a conversation never resurrects old thoughts.
    if (isTransientReasoning) return;
    const identity = event.toolCallId || event.eventId || "";
    const key = `${event.kind}|${identity}|${event.status}|${event.message}`;
    if (!event.message && !event.delta) return;
    // Repeated token chunks are valid provider output. Keep their exact order;
    // only milestone-style events use content de-duplication.
    if (seen.has(key)) return;
    seen.add(key);
    const sequence = events.length + 1;
    const timestamp = Number(event.timestamp || 0) || Date.now();
    events.push({ ...event, timestamp, runId, eventId: runId ? `${runId}:execution:${sequence}` : `execution:${sequence}`, sequence });
  };
  for (const update of Array.isArray(updates) ? updates : []) {
    const timestamp = Number(update?.receivedAt || update?.timestamp || update?.createdAt || 0) || Date.now();
    mapper.consume(update).forEach((event) => append({ ...event, timestamp }));
  }
  const flushedAt = Number(Array.isArray(updates) ? updates.at(-1)?.receivedAt : 0) || Date.now();
  mapper.flush().forEach((event) => append({ ...event, timestamp: flushedAt }));
  return events;
}

module.exports = {
  extractHmsFinalEnvelope,
  HmsMessageStreamDemux,
  HmsProgressMapper,
  buildExecutionLog,
  contentText,
  publicReasoningDelta,
  isConcretePublicReasoning,
  planEvents,
  publicText,
  publicActivityText,
  stripTrailingPartialHmsProtocol,
  stripHmsProgressEnvelopes,
  toolEvent
};
