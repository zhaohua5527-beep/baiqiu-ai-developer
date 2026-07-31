"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TERMINAL_SUCCESS = new Set(["completed", "success", "done"]);
const TERMINAL_FAILURE = new Set(["failed", "cancelled", "timeout", "aborted"]);

function text(value, limit = 1200) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function unique(values, limit = 50) {
  return [...new Set(values.map((item) => text(item)).filter(Boolean))].slice(0, limit);
}

function messageText(message) {
  return text(message?.text || message?.content || "", 2000);
}

function extractReason(value) {
  const source = text(value, 1600);
  const match = source.match(/(?:因为|原因(?:是|：|:)?|考虑到|基于)([^。！？\n]{2,220})/);
  return text(match?.[1] || "未单独记录", 240);
}

function collectFiles(messages, tasks) {
  const files = [];
  const add = (item, source) => {
    const filePath = text(item?.path || item?.originalPath || item?.filePath || item?.url, 1000);
    const name = text(item?.name || (filePath ? path.basename(filePath) : ""), 300);
    if (!name && !filePath) return;
    files.push({ name, path: filePath, source, updatedAt: item?.updatedAt || item?.createdAt || "" });
  };
  for (const entry of messages) {
    for (const attachment of entry.message?.attachments || []) add(attachment, `会话：${entry.sessionName}`);
  }
  for (const task of tasks) {
    for (const attachment of task.attachments || []) add(attachment, `Task Brain：${text(task.goal, 160)}`);
  }
  const seen = new Set();
  return files.filter((item) => {
    const key = `${item.path}|${item.name}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 100);
}

function createConsciousBackup({ project, sessions = [], messagesBySession = {}, tasks = [], queue = [], settings = {}, now = new Date() }) {
  if (!project?.id) throw new Error("项目不存在，无法创建意识备份");
  const linked = sessions.filter((session) => session.projectId === project.id || (project.sessions || []).includes(session.id));
  const linkedIds = new Set(linked.map((session) => session.id));
  const projectTasks = tasks.filter((task) => linkedIds.has(task.session_id || task.sessionId));
  const projectQueue = queue.filter((task) => linkedIds.has(task.sessionId || task.session_id));
  const allMessages = linked.flatMap((session) => (messagesBySession[session.id] || session.messages || []).map((message) => ({
    sessionId: session.id,
    sessionName: session.name || session.title || session.id,
    sessionType: session.type || "chat",
    message
  })));
  const userMessages = allMessages.filter((entry) => entry.message?.role === "user");
  const ceoAssistantMessages = allMessages.filter((entry) => entry.sessionType === "CEO" && entry.message?.role === "assistant");
  const explicitRequirements = unique(userMessages
    .map((entry) => messageText(entry.message))
    .filter((value) => /必须|不要|禁止|需要|要求|记住|优先|保持|只允许|不能|偏好|喜欢/.test(value)), 40);
  const decisionMessages = ceoAssistantMessages
    .map((entry) => messageText(entry.message))
    .filter((value) => /决定|确认|采用|调整|改为|取消|选择|结论/.test(value))
    .slice(-30);
  const completedTasks = unique([
    ...projectTasks.filter((task) => TERMINAL_SUCCESS.has(task.status)).flatMap((task) => task.completed?.length ? task.completed : [task.goal || task.result]),
    ...projectQueue.filter((task) => TERMINAL_SUCCESS.has(task.status)).map((task) => task.title || task.name)
  ], 80);
  const pendingTasks = unique([
    ...projectTasks.filter((task) => !TERMINAL_SUCCESS.has(task.status)).flatMap((task) => task.pending?.length ? task.pending : [task.current_step || task.goal]),
    ...projectQueue.filter((task) => !TERMINAL_SUCCESS.has(task.status) && !TERMINAL_FAILURE.has(task.status)).map((task) => task.title || task.name),
    ...linked.filter((session) => session.type === "Agent" && !TERMINAL_SUCCESS.has(session.status)).map((session) => session.task)
  ], 80);
  const constraints = unique([
    ...projectTasks.flatMap((task) => task.constraints || []),
    ...explicitRequirements
  ], 60);
  const totalTasks = projectTasks.length + projectQueue.length;
  const completedCount = projectTasks.filter((task) => TERMINAL_SUCCESS.has(task.status)).length
    + projectQueue.filter((task) => TERMINAL_SUCCESS.has(task.status)).length;
  const progressPercent = totalTasks ? Math.round((completedCount / totalTasks) * 100) : 0;
  const preferences = settings.personaMemory || {};

  return {
    schemaVersion: 1,
    type: "project-consciousness",
    projectId: project.id,
    projectName: text(project.name, 300),
    createdAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    projectGoal: text(project.description || linked.find((session) => session.type === "CEO")?.task || project.name, 2000),
    background: unique([
      text(project.description, 1500),
      ...userMessages.slice(0, 8).map((entry) => messageText(entry.message))
    ], 12),
    coreDecisions: decisionMessages.map((decision) => ({ decision, reason: extractReason(decision), source: "CEO会话" })),
    currentProgress: {
      percent: progressPercent,
      summary: totalTasks ? `已完成 ${completedCount}/${totalTasks} 项任务` : "尚无可量化任务，保留当前项目上下文",
      currentStages: unique(projectTasks.filter((task) => !TERMINAL_SUCCESS.has(task.status)).map((task) => task.current_stage), 20)
    },
    agentStates: linked.filter((session) => session.type === "CEO" || session.type === "Agent").map((session) => ({
      sessionId: session.id,
      name: text(session.name || session.title, 300),
      type: session.type,
      role: text(session.role, 300),
      task: text(session.task, 1000),
      status: text(session.status || "waiting", 80),
      updatedAt: session.updatedAt || session.createdAt || 0
    })),
    completedTasks,
    pendingTasks,
    projectConstraints: constraints,
    userPreferences: {
      userName: text(preferences.userName, 120),
      assistantName: text(preferences.assistantName, 120),
      role: text(preferences.role, 300),
      persona: text(preferences.persona, 800),
      replyStyle: text(settings.persona?.replyStyle, 500),
      workStyle: text(settings.persona?.workStyle, 500)
    },
    explicitRequirements,
    fileChanges: collectFiles(allMessages, projectTasks),
    nextPlan: pendingTasks.slice(0, 20),
    sourceStats: {
      sessions: linked.length,
      messages: allMessages.length,
      taskBrainTasks: projectTasks.length,
      queuedTasks: projectQueue.length,
      files: collectFiles(allMessages, projectTasks).length
    }
  };
}

function backupFile(root, projectId) {
  return path.join(root, encodeURIComponent(projectId), "latest.json");
}

function writeConsciousBackup(root, backup) {
  const file = backupFile(root, backup.projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(backup, null, 2), "utf8");
  fs.renameSync(temp, file);
  return file;
}

function readConsciousBackup(root, projectId) {
  try {
    const file = backupFile(root, projectId);
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value?.type === "project-consciousness" && value.projectId === projectId ? value : null;
  } catch {
    return null;
  }
}

module.exports = { createConsciousBackup, writeConsciousBackup, readConsciousBackup };
