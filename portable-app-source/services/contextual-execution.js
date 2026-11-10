"use strict";

const REUSABLE_FILE_PATTERN = /\.(?:xlsx|xls|csv|docx|doc|pdf|pptx|ppt|txt|md|json|zip)$/i;

function cleanText(value = "", limit = 8000) {
  return String(value || "").replace(/\r\n/g, "\n").trim().slice(0, limit);
}

function isCompactExecutionConfirmation(value = "") {
  const text = cleanText(value, 120).replace(/\s+/g, " ");
  if (!text || /[?？]/.test(text)) return false;
  return /^(?:(?:对(?:的)?|是的|没错|好的?|可以|行)[\s,，。]*)?(?:(?:现在|那就|就|开始|继续)[\s]*)?(?:执行|开始执行|继续执行|做|开始做|生成|开始生成)(?:吧|了|一下)?[。!！]*$/i.test(text);
}

function recentExecutionTurn(messages = [], limit = 12) {
  const items = (Array.isArray(messages) ? messages : []).slice(-Math.max(2, Number(limit) || 12));
  let assistantIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.role === "assistant" && cleanText(items[index]?.text, 1)) {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 0) return { user: null, assistant: null };
  let user = null;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (items[index]?.role === "user" && cleanText(items[index]?.text, 1)) {
      user = items[index];
      break;
    }
  }
  return { user, assistant: items[assistantIndex] };
}

function taskAttachments(task = {}) {
  const direct = Array.isArray(task.attachments) ? task.attachments : [];
  const workset = Array.isArray(task.workset?.attachments) ? task.workset.attachments : [];
  const seen = new Set();
  return [...direct, ...workset].filter((item) => {
    const key = `${item?.id || ""}|${item?.path || item?.sourcePath || ""}|${item?.name || ""}`;
    if (!key.replace(/\|/g, "") || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasReusableFileWorkset(task = {}) {
  return taskAttachments(task).some((item) => REUSABLE_FILE_PATTERN.test(String(item?.name || item?.path || item?.sourcePath || "")));
}

function selectReusableWorksetTask(tasks = [], preferredTaskId = "") {
  const items = Array.isArray(tasks) ? tasks : [];
  const preferred = cleanText(preferredTaskId, 200);
  if (preferred) {
    const exact = items.find((task) => String(task?.task_id || "") === preferred);
    if (exact && hasReusableFileWorkset(exact)) return exact;
  }
  return items.find(hasReusableFileWorkset) || null;
}

function buildExecutionContinuationInput({ confirmation = "", user = null, assistant = null } = {}) {
  return [
    cleanText(user?.text, 6000) ? `Latest user instruction:\n${cleanText(user.text, 6000)}` : "",
    cleanText(assistant?.text, 6000) ? `Latest assistant execution proposal:\n${cleanText(assistant.text, 6000)}` : "",
    cleanText(confirmation, 1000) ? `User execution confirmation:\n${cleanText(confirmation, 1000)}` : ""
  ].filter(Boolean).join("\n\n");
}

module.exports = {
  buildExecutionContinuationInput,
  hasReusableFileWorkset,
  isCompactExecutionConfirmation,
  recentExecutionTurn,
  selectReusableWorksetTask,
  taskAttachments
};
