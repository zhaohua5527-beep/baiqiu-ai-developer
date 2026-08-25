"use strict";

const TIMING_PROFILES = Object.freeze({
  local_launch: Object.freeze({ expectedMs: 5000, softTimeoutMs: 15000, hardTimeoutMs: 0, heartbeatMs: 3000 }),
  local_create: Object.freeze({ expectedMs: 12000, softTimeoutMs: 30000, hardTimeoutMs: 0, heartbeatMs: 5000 }),
  model_response: Object.freeze({ expectedMs: 30000, softTimeoutMs: 60000, hardTimeoutMs: 0, heartbeatMs: 10000 }),
  agent_execution: Object.freeze({ expectedMs: 90000, softTimeoutMs: 180000, hardTimeoutMs: 0, heartbeatMs: 15000 }),
  update_download: Object.freeze({ expectedMs: 300000, softTimeoutMs: 600000, hardTimeoutMs: 3600000, heartbeatMs: 15000 })
});

function cloneTiming(profile) {
  return { ...profile };
}

function normalizedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function classifyTiming(message = "", intent = "") {
  const text = `${normalizedText(message)} ${normalizedText(intent)}`.toLowerCase();
  // 大型/多步/研究类任务 → agent_execution（长超时，允许 Hermes 长链路）
  // 必须优先于 local_create 判断——"做一个计算器软件/项目"同时命中两者，
  // 但前者代表大型任务，应该给足时间而不是被 local_create 的短超时误杀。
  if (/(研究|分析|整理|开发|构建|编写|多步|项目|agent|hms|hermes|论文|报告|小说|方案|网站|系统)/i.test(text)) return "agent_execution";
  if (/(打开|启动|运行|调出).{0,16}(wps|金山|计算器|calc|软件|应用|程序)/i.test(text)) return "local_launch";
  // "做一个计算器软件/程序/应用"是开发任务（要生成可运行软件、走 Hermes/多agent），
  // 不是本地秒开。含"软件/程序/应用"的"做X"归 agent_execution（600s），
  // 只有"做表格/xlsx"这类确定性短操作才 local_create（90s）。
  if (/(?:生成|创建|制作|新建|做).{0,24}(?:软件|程序|应用)/i.test(text)) return "agent_execution";
  if (/(生成|创建|制作|新建|做).{0,24}(计算器|表格|xlsx|excel|文件|网页)/i.test(text)) return "local_create";
  if (/(下载|更新|安装包|补丁)/i.test(text)) return "update_download";
  return "model_response";
}

function timingForTask({ message = "", intent = "", profile = "", routing = "", executionMode = "", route = "" } = {}) {
  // 真实路由优先：理解层已判定走 Hermes 长链路（execute/delegate 且非本地）时，
  // 给足时间（agent_execution），不再被文本正则压到短超时档。
  // 这符合"HMS 契合"——走 Hermes 就给长预算，走本地确定性任务才用短档。
  // routing 可能为空（前端未传 context.conversationUnderstanding），但任务自身
  // route（如 task_brain）是可靠的执行路径信号，必须纳入判断。
  const routeValue = String(route || routing || "").toLowerCase();
  const mode = String(executionMode || "").toLowerCase();
  const hermesBound = routeValue === "task_brain" || routeValue === "ceo" || ["execute", "delegate"].includes(mode);
  // 本地确定性意图：明确"打开/启动/调出"某应用，或"生成/创建表格"这类短操作。
  // 注意："做一个计算器软件"含"软件/应用/程序"属于开发任务（走 task_brain/Hermes），
  // 不是本地秒开——必须走长超时，否则产物未生成就被 90 秒误杀（task-027）。
  const localOpen = /(?:打开|启动|运行|调出).{0,16}(?:wps|金山|计算器|calc|软件|应用|程序)/i.test(String(message || ""));
  const localCreateShort = /(?:生成|创建|制作|新建|做).{0,24}(?:表格|xlsx|excel|csv)/i.test(String(message || ""))
    && !/软件|系统|项目|网站|程序|应用|开发/i.test(String(message || ""));
  const localIntent = localOpen || localCreateShort;
  if (hermesBound && !localIntent) {
    return { profile: "agent_execution", ...cloneTiming(TIMING_PROFILES.agent_execution) };
  }
  const key = TIMING_PROFILES[profile] ? profile : classifyTiming(message, intent);
  return {
    profile: key,
    ...cloneTiming(TIMING_PROFILES[key])
  };
}

module.exports = { TIMING_PROFILES, classifyTiming, timingForTask };
