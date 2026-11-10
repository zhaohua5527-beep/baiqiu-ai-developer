"use strict";

const path = require("node:path");

const SUCCESS = new Set(["completed", "success", "done"]);
const TERMINAL = new Set(["completed", "success", "done", "failed", "cancelled", "timeout", "aborted"]);

function clean(value, limit = 1200) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function unique(values, limit = 30) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const item = clean(value, 600);
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

function semanticUnique(values, limit = 20) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const item = clean(value, 500);
    const key = item.toLowerCase().replace(/第\s*\d+\s*轮/g, "").replace(/\d+/g, "#").replace(/[\s，。,.!！?？:：；;]/g, "");
    if (!item || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

function messageText(message) {
  return clean(message?.text || message?.content, 4000);
}

function isNoise(text) {
  const value = clean(text, 500);
  if (!value) return true;
  if (/^(好的?|嗯+|哦+|收到|继续|测试|test|1|2|3|哈+|在吗|你好)[。.!！?？]*$/i.test(value)) return true;
  if (/^(任务执行时间过长|正在理解|正在执行|处理中|请稍候)/.test(value)) return true;
  return false;
}

function meaningfulMessages(messages = []) {
  const seen = new Set();
  const result = [];
  for (const message of messages) {
    const text = messageText(message);
    const role = message?.role === "assistant" ? "assistant" : "user";
    const key = `${role}:${text.toLowerCase()}`;
    if (isNoise(text) || seen.has(key)) continue;
    seen.add(key);
    result.push({ role, text, attachments: Array.isArray(message.attachments) ? message.attachments : [] });
  }
  return result;
}

const WORK_SIGNAL = /(项目|任务|目标|阶段|进度|开发|实现|修改|优化|升级|创建|制作|部署|测试|验证|修复|设计|架构|方案|需求|交付|文件|代码|Agent|CEO|Task Brain|决定|确认|采用|选择|调整为|改为|取消|结论|必须|不要|禁止|只能|要求|优先|保持|待办|待完成|未完成|下一步|已完成|完成事项)/i;
const TRANSIENT_SIGNAL = /(^|\n)(搜索结果|联网结果|网页摘要|参考链接|来源[:：]|以下是搜索|根据搜索)|https?:\/\/\S+/i;

function isWorkMessage(message = {}) {
  const text = messageText(message);
  if (!text) return false;
  if (Array.isArray(message.attachments) && message.attachments.length) return true;
  if (TRANSIENT_SIGNAL.test(text) && !/(项目|任务|目标|决定|约束|待办|下一步|文件关系)/i.test(text)) return false;
  if (/^(你好|在吗|谢谢|好的|收到|继续|今天天气|讲个笑话|你是谁)[。？！?!\s]*$/i.test(text)) return false;
  if (/^[^。\n]{1,80}[？?]$/.test(text) && !WORK_SIGNAL.test(text)) return false;
  return WORK_SIGNAL.test(text);
}

function splitStatements(text) {
  return String(text || "").split(/[。！？!?；;\n]+/).map((item) => clean(item, 500)).filter(Boolean);
}

function labeledStatements(statements, labels) {
  const prefix = new RegExp(`^(?:${labels.join("|")})\\s*[：:]?\\s*`, "i");
  return statements
    .filter((item) => prefix.test(item))
    .map((item) => clean(item.replace(prefix, ""), 500))
    .filter(Boolean);
}

function collectFiles(messages = [], tasks = []) {
  const files = [];
  const add = (item) => {
    const filePath = clean(item?.path || item?.originalPath || item?.filePath || item?.url, 1200);
    const name = clean(item?.name || (filePath ? path.basename(filePath) : ""), 300);
    if (name || filePath) files.push(filePath || name);
  };
  for (const message of messages) for (const attachment of message.attachments || []) add(attachment);
  for (const task of tasks) for (const attachment of task.attachments || []) add(attachment);
  return unique(files, 40);
}

function compactTask(task = {}) {
  return {
    task_id: clean(task.task_id, 200),
    session_id: clean(task.session_id || task.sessionId, 200),
    task_type: clean(task.task_type, 120),
    goal: clean(task.goal || task.original_goal, 1000),
    current_stage: clean(task.current_stage || task.status, 200),
    current_step: clean(task.current_step, 500),
    status: clean(task.status || "ready", 80),
    completed: unique(task.completed || [], 30),
    pending: unique(task.pending || [], 30),
    constraints: unique(task.constraints || [], 20),
    acceptance: unique(task.acceptance || [], 20),
    plan: unique(task.plan || task.execution_plan || [], 30)
  };
}

function relevantTasks(tasks = []) {
  const active = tasks.filter((task) => !TERMINAL.has(String(task.status || "").toLowerCase()));
  const completed = tasks.filter((task) => SUCCESS.has(String(task.status || "").toLowerCase())).slice(0, 8);
  const selected = [...active, ...completed];
  const seen = new Set();
  return selected.filter((task) => {
    const key = task.task_id || `${task.session_id}:${task.goal}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20).map(compactTask);
}

function compactContextText(core) {
  const lines = [
    "【核心意识状态】",
    `目标：${core.goal || "继续当前工作"}`,
    `当前阶段：${core.current_stage || "待继续"}`,
    `已完成：${core.completed_tasks.join("；") || "暂无"}`,
    `待办：${core.pending_tasks.join("；") || "根据目标继续推进"}`,
    `已确认决策：${core.decisions.map((item) => item.decision || item).join("；") || "暂无"}`,
    `约束：${core.constraints.join("；") || "无额外约束"}`,
    `重要文件：${core.important_files.join("；") || "暂无"}`,
    `用户偏好：${core.user_preferences.join("；") || "暂无"}`,
    "这是当前会话的结构化参考状态；仅在不与当前用户新指令冲突时使用。"
  ];
  return lines.join("\n");
}

class MemoryDistiller {
  distill({ scope = "session", project = null, sessions = [], messages = [], tasks = [], settings = {} } = {}) {
    const useful = meaningfulMessages(messages);
    const workMessages = useful.filter(isWorkMessage);
    const userStatements = workMessages.filter((message) => message.role === "user").flatMap((message) => splitStatements(message.text));
    const assistantStatements = workMessages.filter((message) => message.role === "assistant").flatMap((message) => splitStatements(message.text));
    const activeTask = tasks.find((task) => !TERMINAL.has(String(task.status || "").toLowerCase()));
    const goalStatement = [...userStatements].reverse().find((item) => /(目标|开发|实现|完成|优化|升级|创建|制作|处理|分析)/.test(item));
    const goal = clean(activeTask?.goal || project?.description || sessions.find((item) => item.type === "CEO")?.task || goalStatement || project?.name || sessions[0]?.title || "继续当前工作", 2000);
    const decisions = unique([...assistantStatements, ...userStatements].filter((item) => /(决定|确认|采用|选择|调整为|改为|取消|结论|不采用)/.test(item)), 20)
      .map((decision) => ({ decision, reason: clean((decision.match(/(?:因为|原因|基于|考虑到)[：:]?(.+)$/) || [])[1] || "由当前会话确认", 300) }));
    const constraints = semanticUnique([
      ...tasks.flatMap((task) => task.constraints || []),
      ...userStatements.filter((item) => /(必须|不要|禁止|只能|需要|要求|优先|保持|不能|以内|以上|以下)/.test(item))
    ], 12);
    const allStatements = [...assistantStatements, ...userStatements];
    const completed = unique([
      ...tasks.filter((task) => SUCCESS.has(String(task.status || "").toLowerCase())).flatMap((task) => task.completed?.length ? task.completed : [task.goal || task.result]),
      ...labeledStatements(allStatements, ["已完成", "完成事项", "完成"])
    ], 40);
    const pending = unique([
      ...tasks.filter((task) => !TERMINAL.has(String(task.status || "").toLowerCase())).flatMap((task) => task.pending?.length ? task.pending : [task.current_step || task.goal]),
      ...labeledStatements(allStatements, ["待办", "待完成", "未完成", "下一步"])
    ], 40);
    const persona = settings.personaMemory || settings.persona || {};
    const preferences = unique([
      ...userStatements.filter((item) => /(偏好|喜欢|不喜欢|以后|后续|每次|称呼|回复风格|做事风格)/.test(item)),
      persona.userName ? `用户姓名：${persona.userName}` : "",
      persona.assistantName ? `AI名称：${persona.assistantName}` : "",
      persona.replyStyle ? `回复风格：${persona.replyStyle}` : "",
      persona.workStyle ? `做事风格：${persona.workStyle}` : ""
    ], 20);
    const agentState = sessions.filter((session) => ["CEO", "Agent"].includes(session.type)).map((session) => ({
      session_id: session.id,
      name: clean(session.name || session.title, 200),
      type: session.type,
      role: clean(session.role, 200),
      task: clean(session.task, 1000),
      status: clean(session.status || "waiting", 80)
    }));
    const core = {
      goal,
      current_stage: clean(activeTask?.current_stage || activeTask?.current_step || sessions.find((item) => item.status === "running")?.status || "已保存会话状态", 500),
      decisions,
      constraints,
      completed_tasks: completed,
      pending_tasks: pending,
      important_files: collectFiles(workMessages, tasks),
      user_preferences: preferences,
      agent_state: agentState
    };
    const compactMessage = compactContextText(core);
    const originalCharacters = messages.reduce((sum, message) => sum + messageText(message).length, 0);
    const distilledCharacters = compactMessage.length;
    return {
      core,
      relevantTasks: relevantTasks(tasks),
      compactMessages: [{ role: "assistant", text: compactMessage, raw: { consciousContext: true, scope } }],
      evidenceSummary: workMessages.slice(-10).map(({ role, text }) => ({ role, text: clean(text, 500) })),
      metrics: {
        originalMessages: messages.length,
        distilledMessages: 1,
        originalCharacters,
        distilledCharacters,
        reductionPercent: originalCharacters ? Math.max(0, Math.round((1 - distilledCharacters / originalCharacters) * 100)) : 0,
        removedNoiseMessages: Math.max(0, messages.length - workMessages.length)
      }
    };
  }
}

module.exports = { MemoryDistiller, meaningfulMessages, isWorkMessage, compactContextText, compactTask };
