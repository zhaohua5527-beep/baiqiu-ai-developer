"use strict";

const { randomUUID } = require("node:crypto");
const { IntentAgent } = require("./intent-agent");
const { roleForIntent, selectedPathFor } = require("./agent-role-protocol");
const { TaskDispatchRouter } = require("./task-dispatch-router");
const { NegativeConstraintResolver } = require("./negative-constraint-resolver");
const { assignmentCapabilityProfile } = require("./task-capability-mapper");

const LEGACY_INTENT_TYPES = Object.freeze([
  "conversation",
  "question",
  "capability_query",
  "execution",
  "feedback",
  "correction",
  "status_query",
  "configuration",
  "system_test"
]);
const INTENT_TYPES = Object.freeze([
  "conversation",
  "capability_query",
  "dispatch_task",
  "project_management",
  "agent_dispatch",
  "status_query",
  "system_test"
]);

const ASSIGNMENT_POLICY = "one_task_one_agent";

const AGENT_COUNT_WORDS = Object.freeze({
  "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
  "六": 6, "七": 7, "八": 8, "九": 9, "十": 10
});

function cleanText(value, limit = 12000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function unique(items = [], limit = 20) {
  return [...new Set(items.map((item) => cleanText(item, 500)).filter(Boolean))].slice(0, limit);
}

function explicitlyRequestedProjectAgents(text = "", context = {}) {
  const value = cleanText(text, 2000).toLowerCase();
  const projectRoles = Array.isArray(context.capabilityContext?.projectRoles)
    ? context.capabilityContext.projectRoles
    : [];
  const runtimeWorkers = Array.isArray(context.capabilityContext?.workers)
    ? context.capabilityContext.workers
    : [];
  const workers = projectRoles.length ? projectRoles : runtimeWorkers;
  const escapeRegExp = (input) => String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const firstMentionIndex = (name) => {
    const normalizedName = cleanText(name, 200);
    if (!normalizedName) return -1;
    const aliases = [...new Set([normalizedName, `员工${normalizedName}`, `agent${normalizedName}`])]
      .sort((left, right) => right.length - left.length);
    for (const alias of aliases) {
      const escaped = escapeRegExp(alias.toLowerCase());
      const pattern = /^\d+$/.test(normalizedName)
        ? `(?<!\\d)${escaped}(?!\\d)`
        : normalizedName.length === 1
          ? `(?<![a-z0-9])${escaped}(?![a-z0-9])`
          : escaped;
      const match = new RegExp(pattern, "i").exec(value);
      if (match) {
        const numericNameUsedAsCount = /^\d+$/.test(normalizedName)
          && alias === normalizedName
          && /^\s*(?:个|名)?\s*(?:子\s*)?agent\b/i.test(value.slice(match.index + alias.length));
        if (numericNameUsedAsCount) continue;
        return match.index;
      }
    }
    return -1;
  };
  const seen = new Set();
  return workers
    .map((worker) => {
      const name = cleanText(worker?.agent_name || worker?.agentName || worker?.name, 200);
      return { worker, name, index: firstMentionIndex(name) };
    })
    .filter((item) => item.index >= 0 && item.worker?.agent_id && !seen.has(item.worker.agent_id) && seen.add(item.worker.agent_id))
    .sort((left, right) => left.index - right.index || right.name.length - left.name.length)
    .map((item) => item.worker);
}

function isSkillCapabilityQuestion(text = "") {
  return /^(?:你)?(?:可以|能|能够|是否可以|能不能|可不可以).{0,12}(?:学习|安装|新增|创建).{0,12}(?:其他|新的|更多)?(?:的)?(?:技能|skill)(?:吗|么|呢|？|\?)?$/i.test(cleanText(text));
}

function isAgentCapabilityQuestion(text = "") {
  const value = cleanText(text, 500);
  return /(?:\u4f60|\u767d\u7403|\u767d\u7403AI).{0,12}(?:\u53ef\u4ee5|\u80fd\u5426|\u80fd\u4e0d\u80fd|\u662f\u5426\u80fd\u591f)?.{0,12}(?:\u81ea\u6211\u5f00\u53d1|\u81ea\u6211\u4fee\u6539|\u81ea\u4e3b\u5f00\u53d1|\u81ea\u5df1\u5f00\u53d1)(?:\u4e86)?(?:\u5417|\u4e48|\u5462)?(?:\uff1f|\?)?$/i.test(value)
    || /(?:\u4f60|\u767d\u7403|\u767d\u7403AI).{0,12}(?:\u6267\u884c\u4efb\u52a1|\u5904\u7406\u4efb\u52a1).{0,12}(?:\u6d41\u7a0b|\u65b9\u5f0f|\u673a\u5236)(?:\u662f\u4ec0\u4e48|\u600e\u6837|\u600e\u4e48|\u5982\u4f55)?(?:\uff1f|\?)?$/i.test(value)
    || /(?:\u4f60|\u767d\u7403|\u767d\u7403AI).{0,12}(?:\u57fa\u4e8e|\u4f7f\u7528|\u5185\u6838|\u5e95\u5c42).{0,16}(?:\u54ea\u4e2a|\u4ec0\u4e48|Hermes|OpenClaw|\u8f6f\u4ef6|\u6846\u67b6|Agent)(?:\u5f00\u53d1\u7684?|\u5b9e\u73b0\u7684?|\u505a\u7684)?(?:\uff1f|\?)?$/i.test(value);
}

function isAmbiguousFitnessPlan(text = "") {
  return /(?:写|做|生成|给).{0,12}(?:健身房|健身).{0,8}(?:方案|计划)/i.test(cleanText(text))
    && !/(?:开店|运营|营销|选址|预算|训练|增肌|减脂|课程|会员体系)/i.test(text);
}

function isProgressiveClarificationRequest(text = "") {
  return /意图仍不明确.{0,30}继续提问|继续缩小范围.{0,30}原需求|意图确认(?:继续|修改|返回修改)|意图确认\s*第?\s*\d{1,2}\s*轮/i.test(cleanText(text));
}

function isAmbiguousSoftwareRequest(text = "") {
  const value = cleanText(text, 300).replace(/[。！!，,\s]/g, "");
  return /^(?:我想|我要|请|请你|帮我|给我)?(?:写|做|开发|设计|弄|搞)(?:一个|个)?(?:软件|系统|项目|应用|APP)$/i.test(value);
}

function isContentGenerationRequest(text = "") {
  return /(?:写|撰写|生成|创作|整理|制作|做|给我).{0,16}(?:方案|计划|论文|文章|短文|小说|故事|剧本|诗歌|长篇|短篇|连载|文案|报告|提纲|视频|短视频|图片|海报|音频|播客|PPT|演示文稿)|(?:方案|计划|论文|文章|短文|小说|故事|剧本|诗歌|长篇|短篇|连载|文案|报告|提纲|视频|短视频|图片|海报|音频|播客|PPT|演示文稿).{0,12}(?:写|撰写|生成|创作|整理|制作|做)/i.test(cleanText(text));
}

function isCreativeGenerationRequest(text = "") {
  return /(?:写|撰写|生成|创作|制作|做|帮我).{0,18}(?:小说|故事|剧本|诗歌|长篇|短篇|连载)|(?:小说|故事|剧本|诗歌|长篇|短篇|连载).{0,18}(?:写|撰写|生成|创作|制作|做)/i.test(cleanText(text));
}

function creativeRequestCompleteness(text = "") {
  const value = cleanText(text, 2000);
  if (!isCreativeGenerationRequest(value)) return { creative: false, score: 0, missing: [] };
  const signals = [
    /(?:科幻|玄幻|奇幻|悬疑|推理|侦探|都市|言情|爱情|历史|武侠|仙侠|恐怖|校园|职场|现实|战争|成长)/i.test(value),
    /(?:短篇|中篇|长篇|连载|章节|正文|大纲|提纲|设定|世界观|人物|角色|剧情|结局|开头|字)/i.test(value),
    /(?:主角|主人公|背景|发生在|关于|围绕|讲述|主题|灵感|设想|设定为)/i.test(value),
    /(?:直接写|先写|先做|先搭|先设计|先确定|从第|第一章|开篇)/i.test(value)
  ];
  const score = signals.filter(Boolean).length;
  const missing = [];
  if (!signals[0]) missing.push("题材方向");
  if (!signals[1]) missing.push("创作范围或交付形式");
  if (!signals[2]) missing.push("核心设定");
  return { creative: true, score, missing };
}

function requestCompletenessFor(text = "", { agentCount = 0 } = {}) {
  const value = cleanText(text, 2000);
  const creative = creativeRequestCompleteness(value);
  if (creative.creative) {
    return Object.freeze({ domain: "creative_writing", complete: creative.score >= 2, score: creative.score, missing: Object.freeze(creative.missing) });
  }
  if (isAmbiguousSoftwareRequest(value)) {
    return Object.freeze({ domain: "software", complete: false, score: 0, missing: Object.freeze(["产品方向"]) });
  }
  if (!agentCount && isContentGenerationRequest(value) && !isContentArtifactRequest(value)) {
    const signals = [
      /(?:关于|围绕|主题|内容是|针对|分析|介绍|讲述)/i.test(value),
      /(?:\d+\s*字|页|章节|详细|简短|大纲|提纲|正文)/i.test(value),
      /(?:用于|面向|给.{0,10}(?:看|使用)|发布|汇报|营销|读者|受众)/i.test(value)
    ];
    const score = signals.filter(Boolean).length;
    return Object.freeze({
      domain: "content_creation",
      complete: score >= 1,
      score,
      missing: Object.freeze(score ? [] : ["内容目标或主题"])
    });
  }
  return Object.freeze({ domain: "general", complete: true, score: 1, missing: Object.freeze([]) });
}

function contentCapabilityFor(text = "") {
  const value = cleanText(text);
  if (/视频|短视频|影片|动画/i.test(value)) return "video_generation";
  if (/图片|海报|配图|封面|插画/i.test(value)) return "image_generation";
  if (/音频|配音|播客|语音/i.test(value)) return "audio_generation";
  if (/PPT|演示文稿|幻灯片/i.test(value)) return "presentation_generation";
  if (/Excel|xlsx|电子表格|工作簿/i.test(value)) return "spreadsheet_generation";
  if (/Word|docx|文档文件/i.test(value)) return "document_generation";
  return "text_generation";
}

function isContentArtifactRequest(text = "") {
  return contentCapabilityFor(text) !== "text_generation";
}

function modelConstraintsFor(text = "", inherited = {}) {
  const value = cleanText(text);
  const explicitlyDisallowed = /(?:不要|禁止|不允许|别|不可).{0,12}(?:本地模型|本地\s*LLM|Ollama)|(?:本地模型|本地\s*LLM|Ollama).{0,12}(?:不要|禁止|不允许|别用|禁用)/i.test(value);
  const explicitlyAllowed = /(?:允许|恢复|改回|切回|继续使用|可以使用|启用).{0,12}(?:本地模型|本地\s*LLM|Ollama)|(?:本地模型|本地\s*LLM|Ollama).{0,12}(?:恢复|改回|切回|启用)/i.test(value);
  const disallowLocalModel = explicitlyDisallowed
    ? true
    : explicitlyAllowed ? false : inherited.disallowLocalModel === true;
  return Object.freeze({
    disallowLocalModel,
    allowLocalFallback: disallowLocalModel ? false : explicitlyAllowed ? true : inherited.allowLocalFallback !== false
  });
}

function speechActFor(text = "", intentType = "conversation", negativeConstraints = null) {
  const constraints = negativeConstraints || NegativeConstraintResolver.resolve(text);
  if (constraints.denyExecution || constraints.denyMutation || constraints.denyAgent || constraints.denyTaskCreation) return "prohibition";
  if (intentType === "correction") return "correction";
  if (["question", "capability_query", "status_query"].includes(intentType) || /[？?]$/.test(text)) return "query";
  if (["execution", "configuration", "system_test"].includes(intentType)) return "command";
  return intentType === "feedback" ? "feedback" : "conversation";
}

function domainFor(text = "", intentType = "conversation", agentCount = 0) {
  const value = cleanText(text);
  if (agentCount > 0 || /(?:Agent|员工|子Agent|项目调度|任务分配)/i.test(value)) return "management";
  if (/(?:技能|skill)/i.test(value)) return "skill";
  if (/(?:代码|源码|程序|软件|模块|接口|更新系统|开发|修复|重构)/i.test(value)) return "development";
  if (/(?:审计|自检|检查架构|验证链路|真实性)/i.test(value) || intentType === "system_test") return "audit";
  if (isContentGenerationRequest(value) || /(?:方案|论文|文章|小说|故事|剧本|诗歌|文案|报告|提纲)/i.test(value)) return "content";
  if (intentType === "configuration") return "configuration";
  return "conversation";
}

function requestedAgentCount(text = "", context = {}) {
  const value = cleanText(text, 2000);
  const explicitlyRequested = explicitlyRequestedProjectAgents(value, context);
  if (explicitlyRequested.length) return Math.min(20, explicitlyRequested.length);
  if (/(?:\u5168\u90e8|\u6240\u6709|\u5168\u4f53).{0,8}(?:\u5458\u5de5|agent)/i.test(value)) {
    const projectRoleCount = Number(context.capabilityContext?.counts?.assignableRoles)
      || Number(context.capabilityContext?.projectRoles?.length)
      || 0;
    return Math.max(1, Math.min(20, projectRoleCount || 1));
  }
  const digit = value.match(/(?:创建|新建|调用|安排|让|测试)?\s*(\d{1,2})\s*(?:个|名)?\s*(?:子\s*)?(?:(?:[\u4e00-\u9fa5A-Za-z]+)?Agent|员工)/i);
  if (digit) return Math.max(1, Math.min(20, Number(digit[1]) || 0));
  const word = value.match(/(?:创建|新建|调用|安排|让|测试)?\s*([一二两三四五六七八九十])\s*(?:个|名)?\s*(?:子\s*)?(?:(?:[\u4e00-\u9fa5A-Za-z]+)?Agent|员工)/i);
  if (word) return AGENT_COUNT_WORDS[word[1]] || 0;
  if (/(?:让|安排|叫|请).{0,12}(?:他们|她们|其他|多个|所有|全部|这些)?\s*(?:子\s*)?(?:员工|Agent).{0,12}(?:分别|各自)|(?:员工|Agent).{0,12}(?:分别|各自)/i.test(value)) {
    const availableWorkers = Number(context.capabilityContext?.counts?.assignableRoles)
      || Number(context.capabilityContext?.projectRoles?.length)
      || Number(context.capabilityContext?.counts?.callableWorkers)
      || Number(context.capabilityContext?.workers?.length)
      || 0;
    return Math.max(2, Math.min(20, availableWorkers || 2));
  }
  return 0;
}

function extractConstraints(text = "") {
  return unique(String(text || "").split(/[，。；;\n]/)
    .filter((item) => /(要求|必须|不要|禁止|只能|需要|风格|保持|以内|以上|以下)/i.test(item)), 10);
}

function isConversationalAnalysisRequest(text = "", context = {}) {
  const value = cleanText(text, 1000);
  if (context.hasAttachments || requestedAgentCount(value, context) > 0) return false;
  const conversational = /(?:分析一下|帮我(?:看一下|看看|分析一下)|给我讲讲|讲讲|说说|聊聊|解释一下)/i.test(value);
  const explicitExecution = /(?:创建|新建|生成|制作|开发|搭建|修改|编辑|修复|重构|删除|移动|保存|下载|上传|部署|运行|执行|打开|关闭|自动化|批量|安装|调用工具)/i.test(value);
  return conversational && !explicitExecution;
}

function isDelegationEvidenceQuery(text = "") {
  const value = cleanText(text, 1200);
  return /(?:你确定|是不是|到底|是否).{0,80}(?:员工|Agent|执行|委派).{0,80}(?:记录|结果|完成|对话框|证据|看到)|(?:没看到|看不到|没有).{0,50}(?:员工|Agent|执行|委派).{0,50}(?:记录|结果|对话框|证据)/i.test(value);
}

function classifyIntentType(text, context = {}) {
  if (isSkillCapabilityQuestion(text) || isAgentCapabilityQuestion(text)) return "capability_query";
  if (/(?:不要|禁止|不允许|别|不可).{0,12}(?:本地模型|本地\s*LLM|Ollama)/i.test(text)) return "configuration";
  if (context.pendingConfirmation && /^(确认|同意|执行|继续|开始|取消|不执行|停止)[。!！?？]*$/i.test(text)) return "execution";
  if (/(运行|开始|执行|进行|重新)?(?:白球)?(?:全链路)?(?:系统)?自检|Debug\s*Center|QA\s*Agent.*(?:检测|测试)|测试(?:系统|模型调用|工具调用|更新服务|文件处理)/i.test(text)) return "system_test";
  if (requestedAgentCount(text, context) > 0
    && /(?:测试一下|实际测试|开始测试|跑一次|试一下|分别测试)/i.test(text)
    && /(?:Agent|员工|子Agent)/i.test(text)) return "execution";
  if (!context.hasAttachments && (/(你有|当前有|项目有|共有|多少|几个|列出|查看).{0,12}(Agent|员工|能力|工具|技能)|(?:Agent|员工|能力|工具|技能).{0,12}(多少|几个|有哪些|列表)|你能做什么|支持什么/i.test(text)
    || /(?:是否|能不能|能否|可不可以|支持不支持).{0,30}(打开|读取|分析|处理|修改|生成|创建|导出|预览|识别|执行|文件|图片|表格)/i.test(text))) return "capability_query";
  if (/(当前|现在|任务|执行|检测|安装|下载|更新).{0,10}(状态|进度|怎么样|到哪)|还要多久|完成了吗|是否完成|进展如何/i.test(text)) return "status_query";
  if (/(设置|配置|切换|启用|停用|修改).{0,24}(模型|API|接口|主题|头像|名称|开机|保存路径|权限|语言)|(?:模型|API\s*Key|Base\s*URL|主题|保存路径).{0,16}(设置|配置|改成|切换)/i.test(text)) return "configuration";
  if (/(不是.{0,30}(而是|是)|我说的是|改成|更正|纠正|重新理解|理解错了|前面说错|应该是)/i.test(text)) return "correction";
  if (/(没理解|没有理解|不理解我|理解偏了|答非所问|不对|错了|体验不好|太卡|卡顿|有问题|反馈)/i.test(text)) return "feedback";
  if (isConversationalAnalysisRequest(text, context)) return "question";
  if (isDelegationEvidenceQuery(text)) return "status_query";
  if (requestedAgentCount(text, context) > 0 && /(写|论文|文章|任务|测试|执行|完成|分析|检查|安排)/i.test(text)) return "execution";
  if (context.hasAttachments && /(分析|处理|读取|打开|总结|整理|识别|修改|导出)/i.test(text)) return "execution";
  if (/(学习|安装|创建|新增).{0,20}(技能|skill)|(技能|skill).{0,20}(学习|安装|创建|新增)/i.test(text)) return "execution";
  if (/(?:分析|检查|审计|排查).{0,16}(?:文件|代码|源码|日志|目录|项目|系统|数据|资料|配置)|(?:文件|代码|源码|日志|目录|项目|系统|数据|资料|配置).{0,16}(?:分析|检查|审计|排查)/i.test(text)) return "execution";
  if (/(创建|新建|生成|制作|开发|搭建|修改|编辑|修复|重构|删除|移动|整理|保存|下载|上传|部署|运行|执行|打开|关闭|自动化|批量|写一|写论文|做一|安排|让员工|让.{0,8}Agent|测试员工|测试.{0,8}Agent)/i.test(text)) return "execution";
  if (/[？?]$/.test(text) || /^(什么|为什么|怎么|如何|谁|哪里|哪种|是否|请问|解释|告诉我)/i.test(text)) return "question";
  return "conversation";
}

function canonicalIntentFor(intentType, text, agentCount = requestedAgentCount(text)) {
  if (intentType === "capability_query") return "capability_query";
  if (intentType === "status_query") return "status_query";
  if (intentType === "system_test") return "system_test";
  if (intentType === "execution") {
    const hasConcreteWork = /(写|论文|文章|分析|检查|生成|制作|开发|任务|完成|处理|整理|测试)/i.test(text);
    const mentionsAgents = /(?:员工|Agent|子Agent)/i.test(text);
    if ((agentCount > 0 || mentionsAgents) && hasConcreteWork) return "dispatch_task";
    if (mentionsAgents && /(创建|新建|调用|调度|安排|分配|让|测试)/i.test(text)) return "agent_dispatch";
    if (/(项目|里程碑|团队|人员|排期|汇报|任务拆解)/i.test(text)) return "project_management";
    return "dispatch_task";
  }
  if (intentType === "configuration" && /(项目|Agent|员工|角色|团队)/i.test(text)) return "project_management";
  return "conversation";
}

function defaultWorkerCount(intent, intentType, text, count) {
  if (intentType !== "execution" || !["dispatch_task", "agent_dispatch"].includes(intent)) return 0;
  if (count > 0) return count;
  return /(安排|让.{0,8}员工|让.{0,8}Agent|写论文|测试.{0,8}员工|测试.{0,8}Agent)/i.test(text) ? 1 : 0;
}

function dispatchTaskName(text, goal) {
  if (/论文|文章|短文/i.test(text)) return "论文";
  if (/分析/i.test(text)) return "分析";
  if (/检查|检测/i.test(text)) return "检查";
  return cleanText(goal, 200) || "任务";
}

function isAnalyzeOnlyRequest(text = "", negativeConstraints = null) {
  const constraints = negativeConstraints || NegativeConstraintResolver.resolve(text);
  return constraints.forceAnalyzeOnly === true;
}

function classificationFor({ text = "", intent = "conversation", intentType = "conversation", taskSpec = null, agentCount = 0, hasAttachments = false, negativeConstraints = null, requirementCompleteness = null } = {}) {
  if (!cleanText(text)) return hasAttachments ? "development_task" : "ambiguous";
  const completeness = requirementCompleteness || requestCompletenessFor(text, { agentCount });
  if (isAmbiguousFitnessPlan(text) || isProgressiveClarificationRequest(text) || completeness.complete === false) return "ambiguous";
  if (isAnalyzeOnlyRequest(text, negativeConstraints)
    && /(?:架构|系统|链路|理解层).{0,12}(?:审计|检查|评估)|(?:审计|检查|评估).{0,12}(?:架构|系统|链路|理解层)/i.test(text)) {
    return "system_audit";
  }
  if (isAnalyzeOnlyRequest(text, negativeConstraints) && (taskSpec?.taskType === "software_development" || /代码|程序|软件|模块|项目/i.test(text))) {
    return "development_task";
  }
  if (isAnalyzeOnlyRequest(text, negativeConstraints) || /(?:架构|系统|模块|链路|代码).{0,12}(?:审计|检查|评估)|(?:审计|检查|评估).{0,12}(?:架构|系统|模块|链路|代码)/i.test(text)) {
    return "system_audit";
  }
  if (intentType === "execution" && agentCount > 0) return "management_task";
  if (["capability_query", "status_query"].includes(intent)) return "information_query";
  if (intentType === "configuration" && /(?:本地模型|本地\s*LLM|Ollama)/i.test(text)) return "chat";
  if (intentType === "execution" && isContentGenerationRequest(text) && !isContentArtifactRequest(text)) return "chat";
  if (intentType === "execution" || intentType === "system_test" || intentType === "configuration" || taskSpec?.taskType === "software_development") {
    return "development_task";
  }
  return "chat";
}

function executionModeFor({ classification = "chat", text = "", negativeConstraints = null } = {}) {
  if (isAnalyzeOnlyRequest(text, negativeConstraints)) return "analyze_only";
  if (classification === "ambiguous") return "clarify";
  if (classification === "system_audit") return "analyze_only";
  if (classification === "management_task") return "delegate";
  if (classification === "development_task") return "execute";
  return "answer";
}

function permissionsForDecision({ text = "", intentType = "conversation", responseMode = "answer", hasAttachments = false, negativeConstraints = null } = {}) {
  const constraints = negativeConstraints || NegativeConstraintResolver.resolve(text);
  if (constraints.forceAnalyzeOnly) {
    return Object.freeze({
      allowTaskCreation: false,
      allowAgent: false,
      allowTools: false,
      allowVerifier: false,
      allowFileWrite: false
    });
  }
  const execution = responseMode === "execute" || responseMode === "delegate";
  const fileWrite = execution && /(?:修改|改动|编辑|写入|保存|创建|删除|生成|制作|开发|导出|下载|安装)/i.test(text);
  const toolExecution = execution && (hasAttachments
    || intentType === "system_test"
    || fileWrite
    || /(?:调用|使用|工具|联网|网络|在线|搜索|打开|关闭|启动|运行|卸载|重启|关机|命令|脚本)/i.test(text));
  return Object.freeze({
    allowTaskCreation: execution,
    allowAgent: execution,
    allowTools: toolExecution,
    allowVerifier: execution,
    allowFileWrite: fileWrite
  });
}

function routingFor(responseMode = "answer") {
  if (responseMode === "analyze_only") return "analysis";
  if (responseMode === "clarify") return "clarification";
  if (responseMode === "execute") return "task_brain";
  if (responseMode === "delegate") return "ceo";
  return "conversation";
}

function requiredCapabilityFor({ classification = "chat", intent = "conversation", domain = "conversation", text = "" } = {}) {
  if (classification === "management_task") return "management_task";
  if (domain === "content") return contentCapabilityFor(text);
  if (classification === "development_task") return "development_task";
  return intent || "conversation";
}

function riskLevelFor(text, intentType) {
  if (/(关机|关闭电脑|重启电脑|删除|清空|格式化|卸载|付款|支付|转账|安装更新|执行脚本|修改系统)/i.test(text)) return "high";
  if (intentType === "configuration" || intentType === "system_test" || /(写入|保存|创建文件|修改文件|安装)/i.test(text)) return "medium";
  return "low";
}

function goalFor(intentType, text) {
  const cleaned = cleanText(text.replace(/^(请|麻烦|可以|能不能|你能|帮我|请你|给我)+/i, ""), 1000);
  if (intentType === "feedback") return "直接分析用户反馈并给出修正后的回应";
  if (intentType === "correction") return "采用用户修正后的上下文并直接回应";
  if (intentType === "capability_query") return "读取当前 Agent 与能力状态";
  if (intentType === "status_query") return "读取当前真实执行状态";
  if (intentType === "system_test") return "运行真实系统自检并汇总结果";
  if (intentType === "configuration") return cleaned || "处理配置请求";
  if (intentType === "question") return cleaned || "回答用户问题";
  if (intentType === "conversation") return cleaned || "继续对话";
  return cleaned || "完成用户请求";
}

function requiredActionFor(intentType) {
  return {
    conversation: "respond",
    question: "answer",
    capability_query: "read_capabilities",
    execution: "execute",
    feedback: "acknowledge_feedback",
    correction: "correct_context",
    status_query: "read_status",
    configuration: "update_configuration",
    system_test: "run_system_test"
  }[intentType] || "respond";
}

function responseModeFor(intentType, role) {
  if (intentType === "execution") return role === "CEO" ? "management_report" : "verified_result";
  return {
    conversation: "conversation_reply",
    question: "direct_answer",
    capability_query: "capability_summary",
    feedback: "direct_analysis",
    correction: "direct_analysis",
    status_query: "status_summary",
    configuration: "configuration_confirmation",
    system_test: "qa_report"
  }[intentType] || "conversation_reply";
}

function expectationFor(intentType) {
  return {
    conversation: "自然交流，不创建任务",
    question: "直接回答问题，不触发执行",
    capability_query: "读取真实能力数据，不执行任务",
    execution: "完成真实执行并返回经过验证的结果",
    feedback: "直接说明判断、原因和修正方案",
    correction: "采用修正后的上下文并直接回答，不创建新任务",
    status_query: "返回真实状态，不制造进度",
    configuration: "明确配置影响并持久化真实修改",
    system_test: "运行真实 QA 探针并返回报告"
  }[intentType] || "直接回应";
}

function taskTypeFor(domainIntent, text, intentType, agentCount) {
  if (intentType === "system_test") return "system_test";
  if (/视频|短视频|影片|动画|图片|海报|配图|封面|插画|音频|配音|播客|语音|PPT|演示文稿|幻灯片/i.test(text)) return "content_artifact";
  if (/(论文|文章|短文|小说|故事|剧本|诗歌|写作|撰写)/i.test(text)) return "content_task";
  if (agentCount > 1) return "agent_collaboration";
  if (/^skill\./.test(domainIntent) || /(技能|skill)/i.test(text)) return "skill_management";
  if (/^dev\./.test(domainIntent) || /(软件|程序|网页|网站|计算器|代码|模块|更新|app)/i.test(text)) return "software_development";
  if (/^file\./.test(domainIntent) || /(文件|目录|文件夹)/i.test(text)) return "file_operation";
  if (/^office\./.test(domainIntent) || /(文档|表格|PPT|Word|Excel|资料|论文|文章)/i.test(text)) return "document_assistance";
  if (/^system\./.test(domainIntent) || /(打开|运行|启动|自动化)/i.test(text)) return "system_operation";
  if (/天气|联网|搜索|查询最新/i.test(text)) return "information_retrieval";
  return "general_execution";
}

function explicitAssignmentScopes(text = "", count = 0) {
  const value = cleanText(text, 3000);
  const candidates = [
    value.match(/(?:维度|方向|范围)(?:为|是|包括|分别是)[：:，,\s]*(.+)$/i)?.[1],
    value.match(/(?:分别负责|分别分析|分别处理)[：:，,\s]*(.+)$/i)?.[1]
  ].filter(Boolean);
  for (const candidate of candidates) {
    const scopes = candidate
      .split(/[、,，;；|]/)
      .map((item) => cleanText(item.replace(/[。.!！?？]+$/, ""), 600))
      .filter(Boolean);
    if (scopes.length >= count && count > 1) return scopes.slice(0, count);
  }
  return [];
}

function requestedAgentAssignments(text = "", count = 0, context = {}) {
  const assignmentCount = count || requestedAgentCount(text, context);
  if (!assignmentCount) return [];
  const explicitlyRequested = explicitlyRequestedProjectAgents(text, context);
  const paperTask = /(?:论文|文章|短文)/i.test(text);
  const developmentTask = /(?:开发|程序|代码|模块|软件|更新).{0,20}(?:修改|改动|编辑|实现|开发)|(?:修改|改动|编辑|实现|开发).{0,20}(?:开发|程序|代码|模块|软件|更新)/i.test(text);
  const mixedDeliveryTest = assignmentCount >= 2
    && /测试/i.test(text)
    && /文件/i.test(text)
    && /(?:文字|文本|对话框)/i.test(text);
  const repeatedTestCount = Math.max(1, Math.min(10, Number((text.match(/(?:分别)?测试\s*(\d{1,2})\s*次/i) || [])[1] || 1)));
  const requestedLength = Number((text.match(/(\d{2,5})\s*字/) || [])[1] || 100);
  const topics = [
    "人工智能技术演进", "人工智能与教育", "人工智能医疗应用", "人工智能伦理与治理",
    "人工智能与产业升级", "人工智能安全与对齐", "人工智能与未来社会", "人工智能创新应用"
  ];
  const delegatedTask = text.match(/(?:请将|将)[“"]([^”"]+)[”"](?:拆解|分配|交给)/i)?.[1];
  const developmentAction = developmentTask
    ? text.replace(/^让.{0,8}员工/i, "").trim()
    : "";
  const commonAction = delegatedTask || developmentAction || (text.match(/每(?:个|名)(?:子\s*)?(?:[\u4e00-\u9fa5A-Za-z]+)?Agent(?:分别)?(?:负责)?[，,:：\s]*(.+)$/i)
    || text.match(/分别[，,:：\s]*(.+)$/i)
    || text.match(/各自?[，,:：\s]*(.+)$/i))?.[1]
    || cleanText(text, 800)
    || "完成分配的独立任务";
  const scopes = explicitAssignmentScopes(text, assignmentCount);
  const projectRoles = Array.isArray(context.capabilityContext?.projectRoles)
    ? context.capabilityContext.projectRoles
    : [];
  return Array.from({ length: assignmentCount }, (_, index) => {
    const requestedWorker = explicitlyRequested[index]
      || (projectRoles.length === assignmentCount ? projectRoles[index] : null);
    const scope = scopes[index] || (paperTask ? topics[index % topics.length] : "");
    const mixedAction = index === 0
      ? `连续完成${repeatedTestCount}次文件输出测试，生成${repeatedTestCount}个内容不同且可打开的真实文本文件，并返回每个文件的真实路径`
      : `连续完成${repeatedTestCount}次对话文字输出测试，在本员工对话框直接返回${repeatedTestCount}段编号清楚、内容不同的完整文字，不创建文件`;
    const action = mixedDeliveryTest
      ? mixedAction
      : paperTask
      ? `独立撰写一篇${topics[index % topics.length]}主题的中文AI论文，正文约${requestedLength}字，只返回本Agent独立完成的论文正文`
      : delegatedTask && count === 1
        ? cleanText(delegatedTask, 1000)
        : `${cleanText(commonAction, 800)}${scope ? `：${scope}` : ""}（第${index + 1}个Agent独立执行，不得模拟其他Agent）`;
    const profile = assignmentCapabilityProfile({
      taskType: paperTask ? "content_task" : developmentTask ? "development_task" : "",
      action,
      role: paperTask ? "AI论文专家" : developmentTask ? "developer" : "执行 Agent",
      capability: paperTask ? "独立论文写作" : developmentTask ? "development_task" : cleanText(commonAction, 200)
    });
    return {
      slot: index + 1,
      ...(requestedWorker?.agent_id ? { agent_id: requestedWorker.agent_id } : {}),
      name: cleanText(requestedWorker?.agent_name || requestedWorker?.agentName || requestedWorker?.name, 200)
        || (paperTask ? `论文专家 ${index + 1}` : developmentTask ? `开发员工 ${index + 1}` : `任务 Agent ${index + 1}`),
      role: cleanText(requestedWorker?.role, 200) || (paperTask ? "AI论文专家" : developmentTask ? "developer" : "执行 Agent"),
      capability: cleanText(requestedWorker?.capability, 200)
        || (paperTask ? "独立论文写作" : developmentTask ? "development_task" : cleanText(commonAction, 200)),
      task: paperTask ? "论文写作" : developmentTask ? "开发修改" : dispatchTaskName(text, action),
      taskType: profile.taskType,
      requiredCapabilities: [...profile.requiredCapabilities],
      capabilities: [...profile.requiredCapabilities],
      action,
      ...(mixedDeliveryTest ? {
        deliveryMode: index === 0 ? "file" : "chat",
        expectedFileCount: index === 0 ? repeatedTestCount : 0
      } : {}),
      scope,
      scopeSpecified: Boolean(scope)
    };
  });
}

function taskSpecFor({ intentType, domainIntent, text, riskLevel, agentCount, context = {} }) {
  const taskType = taskTypeFor(domainIntent, text, intentType, agentCount);
  const agentAssignments = requestedAgentAssignments(text, agentCount, context);
  const assignmentDeliveryModes = [...new Set(agentAssignments.map((item) => item.deliveryMode).filter(Boolean))];
  const deliveryMode = assignmentDeliveryModes.length > 1
    ? "mixed"
    : assignmentDeliveryModes[0]
      || (["software_development", "file_operation", "content_artifact"].includes(taskType)
        || /(?:生成|创建|制作|保存|导出|下载).{0,16}(?:文件|文档|表格|图片|Word|Excel|PDF|PPT|压缩包)/i.test(text)
        ? "file"
        : "chat");
  let plan = agentAssignments.map((item) => item.action);
  if (!plan.length && intentType === "system_test") plan = ["运行真实系统探针", "汇总检测结果并保存报告"];
  if (!plan.length && taskType === "software_development") plan = ["确认目标和交付结构", "创建可运行文件", "实现核心功能与交互", "验证并返回结果"];
  if (!plan.length && taskType === "document_assistance") plan = ["提取内容与格式要求", "独立生成内容", "检查完整性后交付"];
  if (!plan.length && taskType === "file_operation") plan = ["确认目标文件和操作", "执行文件处理", "核验文件结果"];
  if (!plan.length && taskType === "system_operation") plan = ["确认操作目标", "调用本地工具执行", "检查执行状态"];
  if (!plan.length) plan = [goalFor(intentType, text)];
  const requiredTools = [];
  if (taskType === "software_development") requiredTools.push("代码生成", "文件创建");
  if (taskType === "document_assistance") requiredTools.push("内容生成");
  if (taskType === "file_operation") requiredTools.push("文件操作");
  if (taskType === "system_operation") requiredTools.push("本地工具执行");
  if (taskType === "information_retrieval") requiredTools.push("联网搜索");
  if (taskType === "skill_management") requiredTools.push("技能中心");
  if (taskType === "system_test") requiredTools.push("QA Agent");
  return {
    taskType,
    level: 3,
    output: taskType === "system_test" ? "真实 QA 自检报告" : agentAssignments.length ? `${agentAssignments.length}份独立结果` : "真实执行结果",
    deliveryMode,
    requiredTools,
    acceptance: taskType === "system_test"
      ? ["真实探针已经运行", "通过与失败数量来自探针结果", "报告已持久化"]
      : ["真实执行已发生", "结果存在", "质量偏差只提示、不丢弃真实产出"],
    constraints: extractConstraints(text),
    assignmentPolicy: ASSIGNMENT_POLICY,
    plan,
    agentAssignments,
    requiresAssignmentScopeConfirmation: false,
    agentCount,
    requiresConfirmation: riskLevel === "high"
  };
}

class ConversationUnderstandingLayer {
  constructor({
    intentAgent = null,
    dispatchRouter = null,
    clock = () => new Date(),
    idFactory = () => `cu-${randomUUID()}`,
    decisionIdFactory = () => `decision-${randomUUID()}`
  } = {}) {
    this.intentAgent = intentAgent || new IntentAgent();
    this.dispatchRouter = dispatchRouter || new TaskDispatchRouter();
    this.clock = clock;
    this.idFactory = idFactory;
    this.decisionIdFactory = decisionIdFactory;
  }

  understand({ input = "", context = {} } = {}) {
    const text = cleanText(input);
    const negativeConstraints = NegativeConstraintResolver.resolve(text);
    const legacy = this.intentAgent.analyze(text, {
      sessionId: context.sessionId || "",
      hasAttachments: Boolean(context.hasAttachments)
    });
    const intentType = classifyIntentType(text, context);
    const requestedWorkers = requestedAgentCount(text, context);
    const intent = canonicalIntentFor(intentType, text, requestedWorkers);
    const agentCount = negativeConstraints.forceAnalyzeOnly
      ? 0
      : defaultWorkerCount(intent, intentType, text, requestedWorkers);
    const speechAct = speechActFor(text, intentType, negativeConstraints);
    const domain = domainFor(text, intentType, agentCount);
    const riskLevel = riskLevelFor(text, intentType);
    const legacyRole = roleForIntent({ intent, intentType, sessionType: context.sessionType || "" });
    const requirementCompleteness = requestCompletenessFor(text, { agentCount });
    const classification = classificationFor({ text, intent, intentType, agentCount, hasAttachments: Boolean(context.hasAttachments), negativeConstraints, requirementCompleteness });
    const executionMode = executionModeFor({ classification, text, negativeConstraints });
    const permissions = permissionsForDecision({
      text,
      intentType,
      responseMode: executionMode,
      hasAttachments: Boolean(context.hasAttachments),
      negativeConstraints
    });
    const routing = routingFor(executionMode);
    const initialNeedExecution = permissions.allowTaskCreation === true;
    const taskGoal = goalFor(intentType, text);
    const requiredCapability = requiredCapabilityFor({ classification, intent, domain, text });
    const dispatch = this.dispatchRouter.route({
      intent,
      intentType,
      role: legacyRole,
      needExecution: initialNeedExecution,
      capabilityContext: context.capabilityContext || {},
      taskGoal,
      requiredCapability
    });
    const legacyRoute = dispatch.route || selectedPathFor({ intent, intentType, role: legacyRole });
    const legacyResponseMode = responseModeFor(intentType, legacyRole);
    const taskSpec = initialNeedExecution
      ? taskSpecFor({ intentType, domainIntent: legacy.primaryIntent, text, riskLevel, agentCount, context })
      : null;
    const shouldCreateTask = permissions.allowTaskCreation === true
      && ["execute", "delegate"].includes(executionMode)
      && dispatch.allowed !== false;
    const role = classification === "management_task"
      ? "CEO"
      : executionMode === "execute" ? "WORKER" : "ASSISTANT";
    const decisionId = this.decisionIdFactory();
    const modelConstraints = modelConstraintsFor(text, context.modelConstraints || {});
    const executionMetadata = Object.freeze({
      decisionId,
      classification,
      responseMode: executionMode,
      permissions,
      routing
    });
    const taskConstraints = Object.freeze([...(taskSpec?.constraints || extractConstraints(text))]);
    return Object.freeze({
      understandingId: this.idFactory(),
      decisionId,
      classification,
      decisionType: classification,
      requestType: classification,
      responseMode: executionMode,
      permissions,
      routing,
      executionMetadata,
      intent,
      intentType,
      speechAct,
      domain,
      modelConstraints,
      workers: agentCount,
      task: dispatchTaskName(text, taskGoal),
      execute: shouldCreateTask,
      need_execution: shouldCreateTask,
      need_agent: permissions.allowAgent,
      response_mode: legacyResponseMode,
      task_constraints: taskConstraints,
      assignment_policy: ASSIGNMENT_POLICY,
      goal: taskGoal,
      taskGoal,
      requiredCapability,
      context: Object.freeze({
        sessionId: context.sessionId || "",
        projectId: context.projectId || "",
        sessionType: context.sessionType || "",
        hasAttachments: Boolean(context.hasAttachments),
        attachmentCount: Number(context.attachmentCount || 0),
        pendingConfirmation: Boolean(context.pendingConfirmation),
        normalizedInput: text,
        domainIntent: legacy.primaryIntent || "general.chat",
        speechAct,
        domain,
        requirementCompleteness,
        modelConstraints,
        responseMode: legacyResponseMode,
        domainResponseMode: legacy.responseMode || "conversation",
        clauses: Object.freeze([...(legacy.clauses || [])]),
        agentCount,
        taskSpec: taskSpec ? Object.freeze(taskSpec) : null
      }),
      capabilityContext: context.capabilityContext || null,
      dispatch,
      userExpectation: expectationFor(intentType),
      requiredAction: requiredActionFor(intentType),
      riskLevel,
      role,
      route: routing,
      legacyRoute,
      shouldCreateTask,
      analyzedAt: this.clock().toISOString()
    });
  }
}

module.exports = {
  ConversationUnderstandingLayer,
  INTENT_TYPES,
  LEGACY_INTENT_TYPES,
  ASSIGNMENT_POLICY,
  classifyIntentType,
  canonicalIntentFor,
  isAnalyzeOnlyRequest,
  decisionTypeFor: classificationFor,
  classificationFor,
  executionModeFor,
  permissionsForDecision,
  routingFor,
  requiredCapabilityFor,
  responseModeFor,
  requestedAgentCount,
  speechActFor,
  domainFor,
  contentCapabilityFor,
  isContentArtifactRequest,
  isContentGenerationRequest,
  isCreativeGenerationRequest,
  creativeRequestCompleteness,
  requestCompletenessFor,
  modelConstraintsFor,
  requestedAgentAssignments
};
