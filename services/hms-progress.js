"use strict";

const path = require("node:path");
const {
  normalizeSemanticType,
  targetForSemanticType
} = require("./black-ball-public-event-contract");

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
const ACTION_FENCE_PREFIX = "```baiqiu-action";
const BARE_TOOL_ACTION_TYPES = new Set([
  "web_search", "webpage_read", "read_file", "write_file", "write_text_file", "write_xlsx",
  "create_folder", "open_path", "modify_app_file", "find_desktop_files", "recycle_desktop_files",
  "organize_desktop_files", "browser", "browser_open", "browser_open_tab", "browser_list_tabs",
  "browser_select_tab", "browser_close_tab", "browser_inspect", "browser_click",
  "browser_confirm_action", "browser_type", "browser_scroll", "browser_wait", "browser_screenshot",
  "desktop_screenshot", "desktop_click", "desktop_type", "desktop_key", "desktop_scroll",
  "clipboard_read", "clipboard_write", "window_inspect", "window_focus", "window_resize",
  "knowledge_status", "knowledge_search", "terminal", "shell", "delegate_task", "launch_windows_application"
]);

function balancedJsonSlice(source = "", startIndex = 0) {
  const text = String(source || "");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, index + 1);
    }
  }
  return "";
}

function isBareToolAction(value = {}) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  return BARE_TOOL_ACTION_TYPES.has(String(value.type || "").trim().toLowerCase());
}

function bareToolActionPrefix(value = "") {
  const source = String(value || "");
  if (/^\{\s*$/.test(source)) return { confirmed: false };
  const property = /^\{\s*"([^"]*)$/.exec(source);
  if (property) return "type".startsWith(String(property[1] || "").toLowerCase())
    ? { confirmed: false }
    : null;
  if (/^\{\s*"type"\s*(?::\s*)?$/.test(source)) return { confirmed: false };
  const openType = /^\{\s*"type"\s*:\s*"([^"]*)$/.exec(source);
  if (openType) {
    const prefix = String(openType[1] || "").toLowerCase();
    return [...BARE_TOOL_ACTION_TYPES].some((type) => type.startsWith(prefix))
      ? { confirmed: false }
      : null;
  }
  const closedType = /^\{\s*"type"\s*:\s*"([^"]+)"[\s\S]*$/.exec(source);
  return closedType && BARE_TOOL_ACTION_TYPES.has(String(closedType[1] || "").toLowerCase())
    ? { confirmed: true }
    : null;
}

function jsonFenceAtLine(value = "") {
  const source = String(value || "");
  const openPattern = /(?:^|\n)[ \t]*```(?:json)?[ \t]*(?:\r?\n|$)/gi;
  const open = openPattern.exec(source);
  if (!open) return null;
  const index = open.index + (open[0].startsWith("\n") ? 1 : 0);
  const contentStart = open.index + open[0].length;
  const tail = source.slice(contentStart);
  const close = /(?:^|\n)[ \t]*```[ \t]*(?=\r?\n|$)/.exec(tail);
  if (!close) {
    const content = tail.trim();
    let action = null;
    try {
      const parsed = JSON.parse(content);
      if (isBareToolAction(parsed)) action = parsed;
    } catch {}
    return {
      index,
      raw: "",
      action,
      partial: true,
      confirmed: Boolean(action || bareToolActionPrefix(content)?.confirmed)
    };
  }
  const closeStart = contentStart + close.index + (close[0].startsWith("\n") ? 1 : 0);
  const closeEnd = contentStart + close.index + close[0].length;
  const content = source.slice(contentStart, closeStart).trim();
  let action = null;
  try {
    const parsed = JSON.parse(content);
    if (isBareToolAction(parsed)) action = parsed;
  } catch {}
  return {
    index,
    raw: source.slice(index, closeEnd),
    action,
    partial: false,
    confirmed: Boolean(action)
  };
}

function taggedToolActionAtLine(value = "") {
  const source = String(value || "");
  const open = /<baiqiu([-_])action\b[^>]*>/i.exec(source);
  if (!open) return null;
  const separator = open[1];
  const contentStart = open.index + open[0].length;
  const closePattern = new RegExp(`</baiqiu${separator}action\\s*>`, "i");
  const close = closePattern.exec(source.slice(contentStart));
  const contentEnd = close ? contentStart + close.index : source.length;
  const content = source.slice(contentStart, contentEnd).trim();
  let action = null;
  try {
    const parsed = JSON.parse(content);
    if (isBareToolAction(parsed)) action = parsed;
  } catch {}
  return {
    index: open.index,
    raw: close ? source.slice(open.index, contentEnd + close[0].length) : "",
    action,
    discard: true,
    partial: !close,
    confirmed: true
  };
}

function partialJsonFenceSuffixLength(value = "") {
  const source = String(value || "");
  const match = /(?:^|\n)([ \t]*```[a-z]*)$/i.exec(source);
  if (!match) return 0;
  const suffix = match[1].trim().toLowerCase();
  return "```json".startsWith(suffix) ? match[1].length : 0;
}

function bareToolActionAtLine(value = "") {
  const source = String(value || "");
  const pattern = /(?:^|\n)[ \t]*\{/g;
  const fence = jsonFenceAtLine(source);
  const tagged = taggedToolActionAtLine(source);
  const structured = [fence, tagged]
    .filter(Boolean)
    .sort((left, right) => left.index - right.index)[0] || null;
  let match;
  while ((match = pattern.exec(source))) {
    const start = match.index + (match[0].startsWith("\n") ? 1 : 0);
    if (structured && start >= structured.index) return structured;
    const brace = match.index + match[0].lastIndexOf("{");
    const json = balancedJsonSlice(source, brace);
    if (json) {
      try {
        if (isBareToolAction(JSON.parse(json))) {
          return {
            index: start,
            raw: source.slice(start, brace) + json,
            action: JSON.parse(json),
            partial: false,
            confirmed: true
          };
        }
      } catch {}
      pattern.lastIndex = brace + json.length;
      continue;
    }
    const prefix = bareToolActionPrefix(source.slice(brace));
    if (prefix) return { index: start, raw: "", action: null, partial: true, confirmed: prefix.confirmed };
  }
  return structured;
}

function extractBareToolActions(value = "", { allowUnclosedFence = true } = {}) {
  let source = String(value || "");
  let output = "";
  const actions = [];
  while (source) {
    const candidate = bareToolActionAtLine(source);
    if (!candidate) return { text: output + source, actions };
    if (candidate.partial) {
      if (allowUnclosedFence && (candidate.action || candidate.discard)) {
        output += source.slice(0, candidate.index);
        if (candidate.action) actions.push(candidate.action);
        source = "";
        break;
      }
      return { text: output + source, actions };
    }
    output += source.slice(0, candidate.index);
    if (!candidate.action && !candidate.discard) {
      output += candidate.raw;
    } else {
      if (candidate.action) actions.push(candidate.action);
    }
    source = source.slice(candidate.index + candidate.raw.length);
    if (candidate.action || candidate.discard) source = source.replace(/^\r?\n/, "");
  }
  return { text: output, actions };
}

function stripBareToolActionLines(value = "") {
  return extractBareToolActions(value).text;
}

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

function publicToolSource(value = "") {
  let text = Array.isArray(value) ? value.join(" ") : String(value || "");
  text = text
    .replace(/<\/?baiqiu-(?:progress|presentation|outcome|clarification|outline|answer|final)(?:\s+[^>]*)?>/gi, "")
    .replace(/\[(?:Runtime context|System prompt|White Ball tool result)\]/gi, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(SECRET_PATTERNS[0], "[已隐藏密钥]")
    .replace(SECRET_PATTERNS[1], "$1=[已隐藏]");
  return text
    .replace(/\b(authorization|cookie)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[已隐藏]")
    .replace(/\bBearer\s+[a-z0-9._~+/=-]+/gi, "Bearer [已隐藏]")
    .replace(/(--?(?:api[_-]?key|token|password|secret|authorization|cookie)|\/+?(?:api[_-]?key|token|password|secret|authorization|cookie))\s+(?:"[^"]*"|'[^']*'|\S+)/gi, "$1 [已隐藏]")
    .replace(/\b(set|export)\s+((?:api[_-]?key|token|password|secret))\s*=\s*[^\s;]+/gi, "$1 $2=[已隐藏]")
    .trim();
}

function toolSourceText(update = {}) {
  const rawInput = toolInputOf(update);
  const input = rawInput && typeof rawInput === "object" ? rawInput : {};
  const command = input.command || input.cmd || input.script || input.commandLine
    || input.shellCommand || input.args || input.argv || (typeof rawInput === "string" ? rawInput : "");
  const code = input.code || input.content || input.text || input.patch || input.diff || input.source || "";
  return publicToolSource(command || code);
}

function publicToolPayload(value, maxLength = 720) {
  if (value === undefined || value === null || value === "") return "";
  const seen = new WeakSet();
  const sanitize = (item, depth = 0) => {
    if (depth > 6) return "[内容已省略]";
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") return item;
    if (item === null) return null;
    if (typeof item !== "object") return String(item);
    if (seen.has(item)) return "[循环内容]";
    seen.add(item);
    if (Array.isArray(item)) return item.map((entry) => sanitize(entry, depth + 1));
    return Object.fromEntries(Object.entries(item).map(([key, entry]) => [
      key,
      /(?:api[_-]?key|token|password|secret|authorization|cookie)/i.test(key)
        ? "[已隐藏]"
        : sanitize(entry, depth + 1)
    ]));
  };
  let text = "";
  try {
    const safe = sanitize(value);
    text = typeof safe === "string" ? safe : JSON.stringify(safe);
  } catch {
    text = String(value);
  }
  return publicText(text, maxLength);
}

function toolCallObject(update = {}) {
  return update.toolCall && typeof update.toolCall === "object" ? update.toolCall : {};
}

function meaningfulToolValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") {
    const text = value.trim();
    return Boolean(text) && !/^(?:\{\}|\[\]|null)$/i.test(text);
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function firstMeaningfulToolValue(...values) {
  return values.find(meaningfulToolValue);
}

function readableAcpToolContent(content) {
  if (!Array.isArray(content)) return content;
  const values = content.map((item) => {
    if (!item || typeof item !== "object") return item;
    if (item.type === "content" && item.content && typeof item.content === "object") {
      const block = item.content;
      if (block.type === "text") return block.text;
      if (block.type === "resource_link") return { name: block.name, uri: block.uri };
      if (block.type === "image" || block.type === "audio") {
        return { type: block.type, mimeType: block.mimeType, uri: block.uri };
      }
      return block;
    }
    return item;
  }).filter(meaningfulToolValue);
  return values.length === 1 ? values[0] : values;
}

function toolCallIdOf(update = {}) {
  const toolCall = toolCallObject(update);
  return String(
    update.toolCallId
      || update.tool_call_id
      || update.callId
      || update.call_id
      || toolCall.toolCallId
      || toolCall.tool_call_id
      || toolCall.callId
      || toolCall.call_id
      || toolCall.id
      || ""
  ).trim().slice(0, 160);
}

function toolInputOf(update = {}) {
  const toolCall = toolCallObject(update);
  return firstMeaningfulToolValue(
    update.rawInput, update.input, update.arguments, update.parameters, update.params,
    update.toolInput, update.toolArguments,
    toolCall.rawInput, toolCall.input, toolCall.arguments, toolCall.parameters, toolCall.params,
    toolCall.toolInput, toolCall.toolArguments,
    update.payload?.rawInput, update.payload?.input, update.payload?.arguments,
    update.payload?.parameters, update.payload?.params,
    update.data?.rawInput, update.data?.input, update.data?.arguments,
    update.data?.parameters, update.data?.params
  );
}

function toolResultOf(update = {}) {
  const toolCall = toolCallObject(update);
  return firstMeaningfulToolValue(
    update.result, update.rawOutput, update.toolResult, update.rawResult, update.output, update.response,
    toolCall.result, toolCall.rawOutput, toolCall.toolResult, toolCall.rawResult, toolCall.output, toolCall.response,
    update.payload?.result, update.payload?.rawOutput, update.payload?.toolResult,
    update.payload?.rawResult, update.payload?.output, update.payload?.response,
    update.data?.result, update.data?.rawOutput, update.data?.toolResult,
    update.data?.rawResult, update.data?.output, update.data?.response,
    readableAcpToolContent(update.content), update.locations,
    readableAcpToolContent(toolCall.content), toolCall.locations
  );
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
  const declaredSemanticType = payload.semanticType ?? payload.semantic_type ?? payload.type;
  const semanticType = declaredSemanticType === undefined || declaredSemanticType === null || String(declaredSemanticType).trim() === ""
    ? "thinking"
    : normalizeSemanticType(declaredSemanticType);
  if (!["thinking", "action", "cross", "stage_result"].includes(semanticType)) return [];
  const action = publicText(payload.stage || payload.action || "execute", 32) || "execute";
  const status = publicText(payload.status || "running", 24) || "running";
  const segmentId = String(payload.segmentId || payload.segment_id || "").trim().slice(0, 64);
  const evidenceToolCallIds = [...new Set((Array.isArray(payload.evidenceToolCallIds)
    ? payload.evidenceToolCallIds
    : Array.isArray(payload.evidence_tool_call_ids) ? payload.evidence_tool_call_ids : [])
    .map((item) => String(item || "").trim().slice(0, 160))
    .filter(Boolean))];
  // This envelope carries a model-authored durable public progress summary. The
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
    kind: "public_progress",
    type: semanticType,
    semanticType,
    target: targetForSemanticType(semanticType),
    action,
    status,
    track: "public_progress",
    message,
    ...(payload.completed ? { completed: publicText(payload.completed, 240) } : {}),
    ...(payload.next ? { next: publicText(payload.next, 240) } : {}),
    ...(evidenceToolCallIds.length ? { evidenceToolCallIds } : {}),
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
    partialActionFenceSuffixLength(text),
    partialJsonFenceSuffixLength(text),
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
  return /<\/baiu-progress\s*>|<\/baiqiu-progress(?=[^\s>])/i.exec(String(value || ""));
}

function actionFenceOpenMatch(value = "") {
  return /^```baiqiu-action[ \t]*/i.exec(String(value || ""));
}

function actionFenceOpenIndex(value = "") {
  return String(value || "").search(/```baiqiu-action[ \t]*/i);
}

function partialActionFenceSuffixLength(value = "") {
  const source = String(value || "");
  const lower = source.toLowerCase();
  const limit = Math.min(lower.length, ACTION_FENCE_PREFIX.length);
  for (let length = limit; length > 0; length -= 1) {
    if (ACTION_FENCE_PREFIX.startsWith(lower.slice(-length))) return length;
  }
  const start = lower.lastIndexOf(ACTION_FENCE_PREFIX);
  if (start >= 0 && /^[ \t]*$/.test(lower.slice(start + ACTION_FENCE_PREFIX.length))) {
    return source.length - start;
  }
  return 0;
}

function progressCloseIndex(source, start) {
  let inString = false;
  let escaped = false;
  const lower = source.toLowerCase();
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) { escaped = false; continue; }
    if (inString && character === "\\") { escaped = true; continue; }
    if (character === '"') inString = !inString;
    if (!inString && lower.startsWith(PROGRESS_CLOSE_TAG, index)) return index;
  }
  return -1;
}

function partialCodeFenceCloseLength(value = "") {
  const match = String(value || "").match(/`{1,2}$/);
  return match ? match[0].length : 0;
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
  constructor({ requireFinalEnvelope = true, segmentPrefix = "", allowImplicitAnswer = true } = {}) {
    this.buffer = "";
    this.requireFinalEnvelope = requireFinalEnvelope !== false;
    this.allowImplicitAnswer = allowImplicitAnswer !== false;
    this.segmentPrefix = String(segmentPrefix || "").trim().slice(0, 120);
    this.inFinal = false;
    this.finalClosed = false;
    this.inActionFence = false;
    this.inAnswer = false;
    this.currentSegmentId = "";
    this.nextSegmentIndex = 1;
    this.segmentedAnswerSeen = false;
    this.pendingAnswerSegmentId = "";
    this.pendingProgressClose = false;
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
    let visibleDelta = "";
    const progressEvents = [];
    while (this.buffer) {
      if (this.pendingProgressClose) {
        const tail = this.buffer.trimStart();
        const lowerTail = tail.toLowerCase();
        if (!tail || PROGRESS_CLOSE_TAG.startsWith(lowerTail)) {
          if (lowerTail !== PROGRESS_CLOSE_TAG) break;
          this.buffer = "";
        } else if (lowerTail.startsWith(PROGRESS_CLOSE_TAG)) {
          this.buffer = tail.slice(PROGRESS_CLOSE_TAG.length);
        } else {
          let matched = 0;
          while (matched < PROGRESS_CLOSE_TAG.length && lowerTail[matched] === PROGRESS_CLOSE_TAG[matched]) matched += 1;
          this.buffer = matched >= "</baiqiu".length ? tail.slice(matched) : this.buffer;
        }
        this.pendingProgressClose = false;
        continue;
      }
      if (this.inActionFence) {
        const closeIndex = this.buffer.indexOf("```");
        if (closeIndex < 0) {
          const keep = partialCodeFenceCloseLength(this.buffer);
          this.buffer = keep ? this.buffer.slice(-keep) : "";
          break;
        }
        this.buffer = this.buffer.slice(closeIndex + 3);
        this.inActionFence = false;
        continue;
      }
      const progressStart = this.buffer.toLowerCase().indexOf(PROGRESS_OPEN_TAG);
      const pendingProgress = !this.inAnswer && !this.inFinal && progressStart >= 0
        && firstProtocolOpenIndex(this.buffer) === progressStart;
      const earlyActionIndex = pendingProgress ? -1 : actionFenceOpenIndex(this.buffer);
      const actionOpen = earlyActionIndex >= 0 ? actionFenceOpenMatch(this.buffer.slice(earlyActionIndex)) : null;
      if (actionOpen) {
        const plain = this.buffer.slice(0, earlyActionIndex);
        if (this.inAnswer) {
          if (plain) {
            this.answerDeltas.push({ segmentId: this.currentSegmentId, delta: plain });
            this.streamEvents.push({ type: "answer_delta", segmentId: this.currentSegmentId, delta: plain });
          }
          this.completedSegments.push(this.currentSegmentId);
          this.streamEvents.push({ type: "answer_end", segmentId: this.currentSegmentId });
          this.currentSegmentId = "";
          this.inAnswer = false;
        } else if (this.inFinal) {
          if (!this.segmentedAnswerSeen) visibleDelta += plain;
          this.inFinal = false;
          this.finalClosed = true;
        } else if (plain) {
          if (!this.requireFinalEnvelope && !this.protocolSeen) visibleDelta += plain;
          else if (!this.finalClosed) this.publicProgressDelta += plain;
        }
        this.protocolSeen = true;
        this.buffer = this.buffer.slice(earlyActionIndex + actionOpen[0].length);
        this.inActionFence = true;
        continue;
      }
      const partialActionLength = pendingProgress ? 0 : partialActionFenceSuffixLength(this.buffer);
      if (partialActionLength) {
        const plain = this.buffer.slice(0, -partialActionLength);
        if (this.inAnswer) {
          if (plain) {
            this.answerDeltas.push({ segmentId: this.currentSegmentId, delta: plain });
            this.streamEvents.push({ type: "answer_delta", segmentId: this.currentSegmentId, delta: plain });
          }
        } else if (this.inFinal) {
          if (!this.segmentedAnswerSeen) visibleDelta += plain;
        } else if (plain) {
          if (!this.requireFinalEnvelope && !this.protocolSeen) visibleDelta += plain;
          else if (!this.finalClosed) this.publicProgressDelta += plain;
        }
        this.buffer = this.buffer.slice(-partialActionLength);
        break;
      }
      const bareAction = pendingProgress ? null : bareToolActionAtLine(this.buffer);
      if (bareAction) {
        const plain = this.buffer.slice(0, bareAction.index);
        if (this.inAnswer) {
          if (plain) {
            this.answerDeltas.push({ segmentId: this.currentSegmentId, delta: plain });
            this.streamEvents.push({ type: "answer_delta", segmentId: this.currentSegmentId, delta: plain });
          }
        } else if (this.inFinal) {
          if (!this.segmentedAnswerSeen) visibleDelta += plain;
        } else if (plain) {
          if (!this.requireFinalEnvelope && !this.protocolSeen) visibleDelta += plain;
          else if (!this.finalClosed) this.publicProgressDelta += plain;
        }
        if (bareAction.partial) {
          if (bareAction.confirmed && !bareAction.discard && this.inAnswer) this.protocolMalformed = true;
          this.buffer = this.buffer.slice(bareAction.index);
          break;
        }
        if (!bareAction.action && !bareAction.discard) {
          if (this.inAnswer) {
            this.answerDeltas.push({ segmentId: this.currentSegmentId, delta: bareAction.raw });
            this.streamEvents.push({ type: "answer_delta", segmentId: this.currentSegmentId, delta: bareAction.raw });
          } else if (this.inFinal) {
            if (!this.segmentedAnswerSeen) visibleDelta += bareAction.raw;
          } else if (!this.requireFinalEnvelope && !this.protocolSeen) {
            visibleDelta += bareAction.raw;
          } else if (!this.finalClosed) {
            this.publicProgressDelta += bareAction.raw;
          }
        }
        this.buffer = this.buffer.slice(bareAction.index + bareAction.raw.length);
        if (bareAction.action || bareAction.discard) this.buffer = this.buffer.replace(/^\r?\n/, "");
        continue;
      }
      if (!pendingProgress && partialJsonFenceSuffixLength(this.buffer)) break;
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
        const actionIndex = actionFenceOpenIndex(this.buffer);
        if (actionIndex >= 0 && (closeIndex < 0 || actionIndex < closeIndex)) {
          const answerDelta = this.buffer.slice(0, actionIndex);
          if (answerDelta) {
            this.answerDeltas.push({ segmentId: this.currentSegmentId, delta: answerDelta });
            this.streamEvents.push({ type: "answer_delta", segmentId: this.currentSegmentId, delta: answerDelta });
          }
          this.buffer = this.buffer.slice(actionIndex);
          this.completedSegments.push(this.currentSegmentId);
          this.streamEvents.push({ type: "answer_end", segmentId: this.currentSegmentId });
          this.currentSegmentId = "";
          this.inAnswer = false;
          continue;
        }
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
        const actionIndex = actionFenceOpenIndex(this.buffer);
        if (actionIndex >= 0 && (closeIndex < 0 || actionIndex < closeIndex)) {
          if (!this.segmentedAnswerSeen) visibleDelta += this.buffer.slice(0, actionIndex);
          this.buffer = this.buffer.slice(actionIndex);
          this.inFinal = false;
          this.finalClosed = true;
          continue;
        }
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
      const actionIndex = actionFenceOpenIndex(this.buffer);
      const genericProtocolIndexes = [lower.indexOf("<baiqiu-"), lower.indexOf("</baiqiu-")]
        .filter((index) => index >= 0);
      const genericProtocolIndex = genericProtocolIndexes.length ? Math.min(...genericProtocolIndexes) : -1;
      const indexes = [progressIndex, answerIndex, finalIndex, actionIndex, genericProtocolIndex].filter((index) => index >= 0);
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
      if (openIndex === actionIndex) {
        this.protocolSeen = true;
        const openTag = actionFenceOpenMatch(this.buffer.slice(openIndex));
        if (!openTag) {
          this.buffer = this.buffer.slice(openIndex);
          break;
        }
        this.buffer = this.buffer.slice(openIndex + openTag[0].length);
        this.inActionFence = true;
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
      const closeIndex = progressCloseIndex(this.buffer, payloadStart);

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
          this.pendingAnswerSegmentId = this.allowImplicitAnswer ? String(events[0]?.segmentId || "").trim() : "";
          if (!this.pendingAnswerSegmentId) this.protocolMalformed = true;
        } else if (recoveryBoundary.kind === "answer") {
          this.buffer = this.buffer.slice(boundaryStart);
        } else {
          this.buffer = this.buffer.slice(boundaryStart + recoveryBoundary.tag.length);
        }
        continue;
      }
      if (closeIndex < 0) {
        const payload = afterPayload.trimStart();
        const json = payload.startsWith("{") ? balancedJsonSlice(payload) : "";
        const events = json ? this.normalizeProgressEvents(parseProgressEnvelope(json)) : [];
        const suffix = payload.slice(json.length).trimStart();
        if (events.length && suffix.toLowerCase().startsWith("</baiqiu")
          && (PROGRESS_CLOSE_TAG.startsWith(suffix.toLowerCase()) || /^<\/baiqiu(?=$|[^a-z>-])/i.test(suffix))) {
          progressEvents.push(...events);
          events.forEach((event) => this.streamEvents.push({ type: "progress", progress: event }));
          this.pendingAnswerSegmentId = this.allowImplicitAnswer ? String(events[0]?.segmentId || "").trim() : "";
          this.pendingProgressClose = true;
          this.buffer = payload.slice(json.length);
          continue;
        }
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
      this.pendingAnswerSegmentId = this.allowImplicitAnswer ? String(
        events[0]?.segmentId || progressEnvelopeSegmentId(progressPayload)
      ).trim() : "";
      if (this.allowImplicitAnswer && !this.pendingAnswerSegmentId) this.protocolMalformed = true;
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
    if (this.pendingProgressClose && PROGRESS_CLOSE_TAG.startsWith(this.buffer.trim().toLowerCase())) {
      this.buffer = "";
      this.pendingProgressClose = false;
    }
    this.answerDeltas = [];
    this.completedSegments = [];
    this.streamEvents = [];
    const wasInAnswer = this.inAnswer;
    const value = this.buffer;
    this.buffer = "";
    const withoutPartialProtocol = stripTrailingPartialHmsProtocol(value);
    const partialActionLength = partialActionFenceSuffixLength(withoutPartialProtocol);
    const withoutPartialAction = partialActionLength
      ? withoutPartialProtocol.slice(0, -partialActionLength)
      : withoutPartialProtocol;
    const bareAction = bareToolActionAtLine(withoutPartialAction);
    const extractedBareActions = extractBareToolActions(withoutPartialAction);
    const withoutBareAction = bareAction?.partial && bareAction.confirmed && !bareAction.action && !bareAction.discard
      ? withoutPartialAction.slice(0, bareAction.index)
      : extractedBareActions.text;
    const trailingProtocolRemoved = withoutPartialProtocol.length !== value.length;
    const residue = protocolResidue(withoutPartialProtocol)
      || partialProtocolBoundary(withoutPartialProtocol)
      || partialActionLength > 0
      || Boolean(bareAction?.partial && bareAction.confirmed && !bareAction.action && !bareAction.discard)
      || trailingProtocolRemoved;
    if (residue) this.protocolMalformed = true;
    let visibleDelta = !this.requireFinalEnvelope && !this.protocolSeen && !residue ? withoutBareAction : "";
    if (wasInAnswer && value) {
      const answerDelta = withoutBareAction;
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

class HmsUpdateStreamDemux {
  constructor(options = {}) {
    this.messageStream = new HmsMessageStreamDemux(options);
    this.thoughtStream = new HmsMessageStreamDemux({
      ...options, requireFinalEnvelope: true, allowImplicitAnswer: false
    });
  }

  consume(update = {}) {
    const contentType = String(update.content?.type || update.type || "").toLowerCase();
    const reasoningChannel = update.sessionUpdate === "agent_thought_chunk"
      || /^(?:thinking|reasoning|reasoning_content)$/.test(contentType);
    if (reasoningChannel && String(update.visibility || "").toLowerCase() !== "public") {
      return { visibleDelta: "", publicProgressDelta: "", progressEvents: [], answerDeltas: [],
        completedSegments: [], streamEvents: [], protocolError: false, currentSegmentId: "" };
    }
    const stream = reasoningChannel ? this.thoughtStream : this.messageStream;
    stream.nextSegmentIndex = Math.max(this.messageStream.nextSegmentIndex, this.thoughtStream.nextSegmentIndex);
    const parsed = stream.consume(contentText(update));
    return {
      ...parsed,
      visibleDelta: reasoningChannel ? "" : parsed.visibleDelta,
      publicProgressDelta: stream.takePublicProgressDelta(),
      currentSegmentId: stream.currentSegmentId
    };
  }

  flush() {
    const message = this.messageStream.flush();
    const thought = this.thoughtStream.flush();
    return {
      ...message,
      progressEvents: [...message.progressEvents, ...thought.progressEvents],
      answerDeltas: [...message.answerDeltas, ...thought.answerDeltas],
      completedSegments: [...message.completedSegments, ...thought.completedSegments],
      streamEvents: [...message.streamEvents, ...thought.streamEvents],
      protocolError: message.protocolError || thought.protocolError
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
  const toolCall = toolCallObject(update);
  const rawTitle = publicText(update.title || update.name || update.toolName || toolCall.title || toolCall.name || toolCall.toolName || "工具", 48);
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
  const rawInput = toolInputOf(update);
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

function publicToolTarget(input = {}) {
  const targetPath = String(input.path || input.filePath || input.outputPath || "").trim();
  if (targetPath) return `“${path.basename(targetPath)}”`;
  const query = publicText(input.query || input.keyword || input.search || "", 64);
  if (query) return `“${query}”`;
  const url = String(input.url || "").trim();
  if (!url) return "";
  try { return `“${new URL(url).hostname || publicText(url, 64)}”`; }
  catch { return `“${publicText(url, 64)}”`; }
}

function publicVerificationLabel(command = "") {
  if (/(?:^|\s)(?:test|node\s+--test|pytest|jest|vitest)(?:\s|$)/i.test(command)) return "测试";
  if (/(?:build|compile|electron-builder)/i.test(command)) return "构建";
  return "校验";
}

function publicVerificationCounts(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return "";
  const passed = Number(result.passed ?? result.pass ?? result.tests?.passed);
  const failed = Number(result.failed ?? result.fail ?? result.tests?.failed);
  const parts = [];
  if (Number.isFinite(passed) && passed >= 0) parts.push(`${passed} 项通过`);
  if (Number.isFinite(failed) && failed > 0) parts.push(`${failed} 项失败`);
  return parts.join("，");
}

function publicToolNarrative({ toolName = "", command = "", input = {}, result = null, status = "", failed = false, completed = false, errorPreview = "", verificationResult = false, retryCount = 0 } = {}) {
  const normalized = String(toolName || "").toLowerCase();
  const target = publicToolTarget(input);
  const retrying = ["retry", "retrying"].includes(String(status || "").toLowerCase());
  const writing = /(?:write|edit|patch|create_file|create_folder)/.test(normalized);
  const reading = /(?:read_file|read_text|load_file)/.test(normalized);
  const searching = /(?:web_search|search)/.test(normalized);
  const browsing = /(?:browser|open_url|fetch_url)/.test(normalized);
  const verificationLabel = verificationResult ? publicVerificationLabel(command) : "";
  const operation = verificationLabel
    || (writing ? "文件写入" : reading ? "文件读取" : searching ? "搜索" : browsing ? "页面访问"
      : /(?:git\s+rev-parse|(?:^|\s)(?:pwd|Get-Location)(?:\s|$))/i.test(command) ? "目录检查"
        : /git\s+status/i.test(command) ? "版本状态检查" : "任务步骤");
  if (retrying) {
    retryCount = Math.max(0, Number(retryCount || 0) || 0);
    return {
      publicSummary: `${operation}正在${retryCount ? `进行第 ${retryCount} 次` : ""}重试`,
      publicSummaryKind: "retry",
      publicSummarySalient: true
    };
  }
  if (failed) {
    return {
      publicSummary: `${operation}未完成${errorPreview ? `：${publicText(errorPreview, 120)}` : ""}`,
      publicSummaryKind: "failure",
      publicSummarySalient: true
    };
  }
  if (writing) {
    return {
      publicSummary: completed ? `已写入${target || "文件"}` : `正在写入${target || "文件"}`,
      publicSummaryKind: "write",
      publicSummarySalient: true
    };
  }
  if (verificationResult) {
    const counts = completed ? publicVerificationCounts(result) : "";
    return {
      publicSummary: completed ? `${verificationLabel}完成${counts ? `：${counts}` : ""}` : `正在进行${verificationLabel}`,
      publicSummaryKind: "verification",
      publicSummarySalient: true
    };
  }
  if (reading) {
    return {
      publicSummary: completed ? `已读取${target || "文件"}` : `正在读取${target || "文件"}`,
      publicSummaryKind: completed ? "result" : "action",
      publicSummarySalient: false
    };
  }
  if (searching) {
    return {
      publicSummary: completed ? `搜索已返回结果${target ? `：${target}` : ""}` : `正在搜索${target}`,
      publicSummaryKind: completed ? "result" : "action",
      publicSummarySalient: false
    };
  }
  if (browsing) {
    return {
      publicSummary: completed ? `页面访问已完成${target ? `：${target}` : ""}` : `正在访问${target || "页面"}`,
      publicSummaryKind: completed ? "result" : "action",
      publicSummarySalient: false
    };
  }
  return {
    publicSummary: completed ? `${operation}已完成` : `正在执行${operation}`,
    publicSummaryKind: completed ? "result" : "action",
    publicSummarySalient: false
  };
}

function toolEvent(update = {}) {
  const { label, target, command } = toolDescriptor(update);
  const sourceText = toolSourceText(update);
  const toolCall = toolCallObject(update);
  const toolName = String(update.title || update.name || update.toolName || toolCall.title || toolCall.name || toolCall.toolName || "").toLowerCase();
  const input = toolInputOf(update);
  const targetPath = String(input?.path || input?.filePath || input?.outputPath || "").toLowerCase();
  const displayKind = /(?:terminal|shell|powershell|cmd)/.test(toolName)
    ? "command"
    : /(?:write_file|edit_file|patch)/.test(toolName) && /\.(?:js|ts|jsx|tsx|py|java|go|rs|css|html|json)$/i.test(targetPath)
      ? "code"
      : "tool";
  const status = String(update.status || update.state || "").toLowerCase();
  const toolCallId = toolCallIdOf(update);
  const result = toolResultOf(update);
  const failed = Boolean(update.error) || result?.success === false || ["failed", "error", "cancelled"].includes(status);
  const completed = !failed && (["completed", "complete", "success", "done"].includes(status)
    || (update.sessionUpdate === "tool_call_update" && meaningfulToolValue(result)));
  const state = failed ? "failed" : completed ? "completed" : "running";
  const verificationResult = update.verification === true
    || String(update.resultKind || update.resultType || "").toLowerCase() === "verification_result"
    || /(?:test|verify|verification|lint|typecheck|build|compile|check)/i.test(`${toolName} ${command}`);
  const eventType = update.sessionUpdate === "tool_call"
    ? "tool_call"
    : (completed || failed ? (verificationResult ? "verification_result" : "tool_result") : "tool_call_update");
  const resultKind = completed || failed
    ? (verificationResult ? "verification_result" : "tool_result")
    : "tool_started";
  const verb = failed ? "失败" : completed ? "已完成" : "正在执行";
  const inputPreview = publicToolPayload(input, Number.MAX_SAFE_INTEGER);
  const resultPreview = publicToolPayload(result, Number.MAX_SAFE_INTEGER);
  const errorPreview = publicToolPayload(update.error, Number.MAX_SAFE_INTEGER);
  const publicNarrative = publicToolNarrative({
    toolName,
    command,
    input,
    result,
    status,
    failed,
    completed,
    errorPreview,
    verificationResult,
    retryCount: update.retryCount || update.retry_count
  });
  const actionText = `${label}${displayKind === "command" && command ? `：${command}` : ""}`
    + (inputPreview ? `：输入 ${inputPreview}` : target ? `：${target}` : "")
    + (resultPreview ? `；结果 ${resultPreview}` : errorPreview ? `；错误 ${errorPreview}` : `；${verb}`);
  const segmentId = String(update.segmentId || update.segment_id || update.toolCall?.segmentId || "").trim().slice(0, 64);
  return {
    source: "tool",
    actor: "model",
    provenance: "blackball_tool",
    kind: "tool",
    type: eventType,
    semanticType: "tool",
    resultKind,
    ...(update.eventId ? { eventId: String(update.eventId) } : {}),
    ...(Number(update.sequence) > 0 ? { sequence: Number(update.sequence) } : {}),
    action: "tool",
    status: state,
    ...(toolCallId ? { toolCallId } : {}),
    ...(segmentId ? { segmentId } : {}),
    title: publicText(update.title || update.name || update.toolName || toolCall.title || toolCall.name || toolCall.toolName || label, 80),
    displayKind,
    target: publicText(target, 80),
    ...(sourceText ? { sourceText } : {}),
    inputPreview,
    ...(resultPreview ? { resultPreview } : {}),
    ...(errorPreview ? { errorPreview } : {}),
    ...publicNarrative,
    publicActionId: toolCallId || String(update.eventId || "").trim().slice(0, 160),
    message: publicText(actionText, 1200)
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
      semanticType: "action",
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
    this.messageStream = new HmsUpdateStreamDemux({ segmentPrefix: this.segmentPrefix });
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
    const generation = update._meta?.baiqiu_execution;
    if (type === "agent_message_chunk" && update.content?.type === "text" && update.content.text === ""
      && generation?.type === "tool_generating"
      && typeof generation.eventId === "string" && generation.eventId.trim()
      && typeof generation.message === "string" && generation.message.trim()
      && Number.isFinite(generation.timestamp) && generation.timestamp > 0) {
      return this._attachActiveSegment([{
        source: "tool",
        actor: "model",
        provenance: "blackball_tool",
        kind: "tool",
        type: "tool_generating",
        semanticType: "tool",
        resultKind: "tool_generating",
        action: "tool_generating",
        status: "running",
        target: "execution_activity",
        displayKind: "tool",
        eventId: generation.eventId,
        timestamp: generation.timestamp,
        title: generation.message,
        message: generation.message
      }]);
    }
    if (type === "prompt_boundary") {
      this.messageStream = new HmsUpdateStreamDemux({ segmentPrefix: this.segmentPrefix });
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
      if (String(update.visibility || "").toLowerCase() !== "public") return [];
      const parsed = parsedStream && typeof parsedStream === "object"
        ? parsedStream
        : this.messageStream.consume(update);
      const reasoning = publicReasoningDelta(parsed.publicProgressDelta);
      const events = [...parsed.progressEvents];
      if (String(update.visibility || "").toLowerCase() === "public"
        && isConcretePublicReasoning(reasoning)) {
        events.push(this._reasoningDeltaEvent(reasoning, update, parsed.currentSegmentId));
      }
      return this._attachActiveSegment(events);
    }
    if (type === "agent_message_chunk") {
      this.lastChannel = "message";
      const parsed = parsedStream && typeof parsedStream === "object"
        ? parsedStream
        : this.messageStream.consume(update);
      // Normal message chunks are the answer channel. Do not turn plain
      // answer text into a second synthetic reasoning stream.
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
      const toolCallId = toolCallIdOf(update);
      const previous = toolCallId ? (this.toolStates.get(toolCallId) || {}) : {};
      const mergedInput = firstMeaningfulToolValue(toolInputOf(update), toolInputOf(previous));
      const mergedResult = firstMeaningfulToolValue(toolResultOf(update), toolResultOf(previous));
      const mergedTool = {
        ...previous,
        ...update,
        ...(toolCallId ? { toolCallId } : {}),
        ...(meaningfulToolValue(mergedInput) ? { rawInput: mergedInput } : {}),
        ...(meaningfulToolValue(mergedResult) ? { rawOutput: mergedResult } : {}),
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
      semanticType: "thinking",
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

function toolEvidenceEventId(turnId = "", event = {}) {
  const root = String(turnId || "").trim();
  const toolCallId = String(event.toolCallId || event.tool_call_id || "").trim().slice(0, 160);
  const type = String(event.type || event.resultKind || "").trim().toLowerCase();
  if (!root || !toolCallId || !["tool_result", "verification_result"].includes(type)) return "";
  return `${root}:tool:${toolCallId}:${type}`;
}

function buildExecutionLog(updates = [], { runId = "", eventIdRoot = runId } = {}) {
  const mapper = new HmsProgressMapper();
  const events = [];
  const append = (event) => {
    const kind = String(event.kind || "").toLowerCase();
    // Structured summaries persist in structuredEvents, while native public
    // thought remains transient. Neither belongs in the execution timeline.
    if (["reasoning_delta", "reasoning_note", "public_reasoning", "public_progress"].includes(kind)) return;
    if (!event.message && !event.delta) return;
    const sequence = events.length + 1;
    const timestamp = Number(event.timestamp || 0) || Date.now();
    events.push({
      ...event,
      timestamp,
      runId,
      eventId: event.eventId
        || toolEvidenceEventId(eventIdRoot, event)
        || (runId ? `${runId}:execution:${sequence}` : `execution:${sequence}`),
      sequence
    });
  };
  for (const update of Array.isArray(updates) ? updates : []) {
    const timestamp = Number(update?.receivedAt || update?.timestamp || update?.createdAt || 0) || Date.now();
    mapper.consume(update).forEach((event) => append({
      ...event,
      timestamp: Number(event.timestamp || 0) || timestamp,
      ...(Number(update?.turnSequence || 0) > 0 ? { turnSequence: Number(update.turnSequence) } : {})
    }));
  }
  const flushedAt = Number(Array.isArray(updates) ? updates.at(-1)?.receivedAt : 0) || Date.now();
  mapper.flush().forEach((event) => append({ ...event, timestamp: flushedAt }));
  return events;
}

module.exports = {
  extractHmsFinalEnvelope,
  HmsMessageStreamDemux,
  HmsUpdateStreamDemux,
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
  extractBareToolActions,
  stripBareToolActionLines,
  toolEvidenceEventId,
  toolEvent
};
