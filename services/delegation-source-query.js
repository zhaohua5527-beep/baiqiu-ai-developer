const { extractDelegationIds, formatDelegationResults, hermesDelegationEvidence, waitForHermesDelegationCompletion } = require("./hermes-delegation");

function normalizeQueryText(text = "") {
  return String(text || "").trim();
}

function isDelegationTaskCommand(text = "") {
  const value = normalizeQueryText(text);
  if (!value) return false;
  const sourceQuestionPattern = /(?:\u8c01|\u54ea\u4e2a|\u54ea\u4f4d|\u54ea\u4e00\u4e2a|\u662f\u4e0d\u662f|\u662f\u5426|\u8fd9\u6b21|\u521a\u624d|\u4e0a\u4e00\u8f6e|\u4e0a\u4e00\u6761)/u;
  const sourceActionPattern = /(?:\u5199\u7684|\u505a\u7684|\u751f\u6210\u7684|\u5b8c\u6210\u7684|\u5904\u7406\u7684|\u5206\u6790\u7684|\u56de\u7b54\u7684|\u4ea7\u51fa\u7684|\u8d1f\u8d23|\u6765\u6e90|\u8ffd\u6eaf|\u5b50\s*agent|agent|worker|\u5458\u5de5)/iu;
  if (sourceQuestionPattern.test(value) && sourceActionPattern.test(value)) return false;
  const hasWorkerTarget = /(?:\u5458\u5de5|\u5b50\s*agent|agent|worker)/iu.test(value);
  const hasTaskVerb = /(?:\u6267\u884c|\u5f00\u59cb|\u8fd0\u884c|\u6d4b\u8bd5|\u68c0\u9a8c|\u9a8c\u8bc1|\u5206\u6790|\u5904\u7406|\u751f\u6210|\u5199|\u505a|\u4ea7\u51fa|\u8f93\u51fa|\u5206\u6bb5|\u5148\u8ba9|\u518d\u8ba9|\u8ba9|\u53eb|\u8bf7)/u.test(value);
  return hasWorkerTarget && hasTaskVerb;
}

function isDelegationSourceQuery(text = "") {
  const value = normalizeQueryText(text);
  if (!value) return false;
  if (isDelegationTaskCommand(value)) return false;
  return /(?:哪个|哪位|哪一个).{0,8}(?:子\s*agent|子任务|员工|worker|agent).{0,24}(?:写|做|生成|完成|处理|分析|返回|回答|产出|负责)|(?:谁|哪位|哪个).{0,12}(?:写的|做的|生成的|完成的|处理的|分析的|回答的|产出的|负责的)|(?:来源|出处|追溯|上一个|上一轮).{0,20}(?:子\s*agent|子任务|员工|委派|任务|结果)|(?:刚才|前一轮|上一轮).{0,12}(?:谁|哪个).{0,18}(?:写|做|完成|生成|处理|分析)/i.test(value);
}

function delegationPayloadCandidates(message = {}) {
  const raw = message?.raw && typeof message.raw === "object" ? message.raw : {};
  const productResult = raw?.productResult && typeof raw.productResult === "object" ? raw.productResult : {};
  const productRaw = productResult?.raw && typeof productResult.raw === "object" ? productResult.raw : {};
  const nestedRaw = raw?.raw && typeof raw.raw === "object" ? raw.raw : {};
  const directResult = raw?.result && typeof raw.result === "object" ? raw.result : {};
  const response = raw?.response && typeof raw.response === "object" ? raw.response : {};
  return [raw, productResult, productRaw, nestedRaw, directResult, response].filter((item) => item && typeof item === "object");
}

function collectDelegationArtifacts(message = {}) {
  const delegationIds = new Set();
  const delegationResults = [];
  const toolCalls = [];
  const seenResults = new Set();

  for (const candidate of delegationPayloadCandidates(message)) {
    if (Array.isArray(candidate.delegationIds)) {
      for (const id of candidate.delegationIds) {
        const value = String(id || "").trim();
        if (value) delegationIds.add(value);
      }
    }
    if (Array.isArray(candidate.delegationResults)) {
      for (const result of candidate.delegationResults) {
        const key = JSON.stringify(result || {});
        if (seenResults.has(key)) continue;
        seenResults.add(key);
        delegationResults.push(result);
      }
    }
    if (Array.isArray(candidate.toolCalls)) {
      toolCalls.push(...candidate.toolCalls);
    }
    if (Array.isArray(candidate.delegationEvidence)) {
      for (const item of candidate.delegationEvidence) {
        if (item && typeof item === "object" && Array.isArray(item.delegationIds)) {
          for (const id of item.delegationIds) {
            const value = String(id || "").trim();
            if (value) delegationIds.add(value);
          }
        }
      }
    }
  }

  const evidence = hermesDelegationEvidence(toolCalls);
  for (const item of evidence) {
    for (const id of item.delegationIds || []) {
      const value = String(id || "").trim();
      if (value) delegationIds.add(value);
    }
  }

  return {
    delegationIds: [...delegationIds],
    delegationResults,
    delegationEvidence: evidence,
    toolCalls
  };
}

async function resolveDelegationSourceReply({
  sessionId = "",
  session = null,
  db = null,
  text = "",
  waitForDelegation = waitForHermesDelegationCompletion,
  formatResults = formatDelegationResults
} = {}) {
  const queryText = normalizeQueryText(text);
  if (!isDelegationSourceQuery(queryText)) {
    return { matched: false, text: "" };
  }
  const messages = Array.isArray(db?.messages?.[sessionId]) ? db.messages[sessionId] : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const artifacts = collectDelegationArtifacts(message);
    let results = artifacts.delegationResults;
    if (!results.length && artifacts.delegationIds.length) {
      const completion = await waitForDelegation(artifacts.delegationIds, { timeoutMs: 1000, intervalMs: 80 });
      if (completion?.status === "completed" && Array.isArray(completion.results)) results = completion.results;
    }
    if (results.length) {
      const body = formatResults(results).trim();
      if (body) {
        return {
          matched: true,
          text: `这次是上一轮真实委派结果，来源可追溯：\n\n${body}`,
          delegationIds: artifacts.delegationIds,
          delegationResults: results,
          delegationEvidence: artifacts.delegationEvidence,
          sourceMessageIndex: index,
          sessionId
        };
      }
    }
    if (artifacts.delegationIds.length || artifacts.delegationEvidence.length) {
      return {
        matched: true,
        text: session?.pendingDelegation?.required
          ? "这轮任务还在进行中，暂时没有可追溯的子 Agent 结果。"
          : "我找到了委派痕迹，但没有拿到可回溯的真实结果。它可能还在进行中，或者相关记录已经清空。",
        delegationIds: artifacts.delegationIds,
        delegationResults: [],
        delegationEvidence: artifacts.delegationEvidence,
        sourceMessageIndex: index,
        sessionId
      };
    }
  }
  return {
    matched: true,
    text: session?.pendingDelegation?.required
      ? "这轮任务还在进行中，暂时没有可追溯的子 Agent 结果。"
      : "我没有找到这条回复对应的真实子 Agent 记录；它可能是主模型直接生成的，或者相关执行记录已经清空。",
    delegationIds: [],
    delegationResults: [],
    delegationEvidence: [],
    sourceMessageIndex: -1,
    sessionId
  };
}

module.exports = {
  collectDelegationArtifacts,
  isDelegationTaskCommand,
  isDelegationSourceQuery,
  resolveDelegationSourceReply
};
