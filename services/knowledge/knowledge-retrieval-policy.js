"use strict";

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

const EXPLICIT_KNOWLEDGE = /(知识星球|知识库|本地知识|资料库|历史记录|以前|之前|上次|曾经|还记得|记忆|沉淀|归纳|决策|方案|需求|约束|项目资料|项目文档|参考资料|根据.*资料|我们.*说过)/i;
const KNOWLEDGE_SOURCE = /(知识星球|知识库|本地知识|资料库|项目资料|项目文档|参考资料)/i;
const WORK_CONTEXT = /(项目|任务|目标|阶段|进度|开发|实现|修改|优化|升级|部署|测试|验证|修复|设计|架构|方案|需求|交付|代码|文件|Agent|CEO|决定|约束|待办|下一步)/i;
const TRANSIENT_ONLY = /(今天|现在|当前|实时|最新|刚刚).*(天气|新闻|股价|汇率|比赛|热搜|路况)|天气|几点|几号|联网搜索|网页搜索|查一下新闻/i;
// “继续”依赖上一轮上下文，不能按寒暄处理；它需要触发知识和连续上下文检索。
const SIMPLE = /^(你好|在吗|谢谢|好的|收到|嗯|哦|测试|test|讲个笑话|你是谁)[。！？?!\s]*$/i;
const CALCULATION = /^[\d\s()+\-*/%.=×÷]+[？?]?$/;
const ENTITY_SIGNAL = /([\u4e00-\u9fa5A-Za-z0-9_-]{2,24}(?:店|门店|项目|品牌|公司|账号|客户|活动))/gu;
const ENTITY_QUERY_INTENT = /(查|找|调取|引用|参考|根据|结合|之前|以前|上次|历史|资料|方案|总结|复盘|继续|怎么做|怎么处理)/i;

function normalizeEntitySignal(value = "") {
  let entity = clean(value).replace(/^(?:查一下|找一下|调取|引用|参考|根据|结合|继续)/, "");
  const stop = entity.search(/(?:之前|以前|上次|历史|资料|方案|总结|复盘|怎么做|怎么处理)/);
  if (stop > 0) entity = entity.slice(0, stop);
  const shortestBusinessObject = entity.match(/^(.{1,24}?(?:门店|店|项目|品牌|公司|账号|客户))/u)?.[1];
  if (shortestBusinessObject) entity = shortestBusinessObject;
  return clean(entity, 80);
}

function entitySignals(value = "") {
  const found = [];
  const seen = new Set();
  for (const match of String(value || "").matchAll(ENTITY_SIGNAL)) {
    const entity = normalizeEntitySignal(match[1]);
    const key = entity.toLowerCase();
    if (!entity || seen.has(key)) continue;
    seen.add(key);
    found.push(entity);
    if (found.length >= 4) break;
  }
  return found;
}

function knowledgeRetrievalDecision({ message = "", hasProject = false } = {}) {
  const value = clean(message).slice(0, 2400);
  if (value.length < 2) return { retrieve: false, reason: "too_short" };
  if (SIMPLE.test(value)) return { retrieve: false, reason: "simple_conversation" };
  if (CALCULATION.test(value)) return { retrieve: false, reason: "calculation" };

  const explicit = EXPLICIT_KNOWLEDGE.test(value);
  const sourceExplicit = KNOWLEDGE_SOURCE.test(value);
  const entities = entitySignals(value);
  const entityScoped = entities.length > 0 && (explicit || ENTITY_QUERY_INTENT.test(value));
  if (TRANSIENT_ONLY.test(value) && !explicit) return { retrieve: false, reason: "transient_information" };

  if (entityScoped) {
    return {
      retrieve: true,
      reason: "entity_knowledge_signal",
      scope: "entity",
      entities,
      allowGlobal: sourceExplicit && !hasProject
    };
  }

  if (hasProject) {
    return {
      retrieve: true,
      reason: explicit
        ? "project_explicit_knowledge_signal"
        : (WORK_CONTEXT.test(value) ? "project_work_context" : "project_conversation"),
      scope: "project",
      entities: [],
      allowGlobal: false
    };
  }

  if (sourceExplicit) {
    return {
      retrieve: true,
      reason: "explicit_knowledge_source",
      scope: "global",
      entities: [],
      allowGlobal: true
    };
  }

  return {
    retrieve: true,
    reason: WORK_CONTEXT.test(value) ? "global_work_context" : "global_conversation",
    scope: "global",
    entities: [],
    allowGlobal: true
  };
}

module.exports = { knowledgeRetrievalDecision, entitySignals };
