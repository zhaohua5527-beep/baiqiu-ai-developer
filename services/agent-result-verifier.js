"use strict";

function embeddedVerification(execution = {}) {
  return execution.normalized?.meta?.verification
    || execution.response?.verification
    || execution.verification?.meta?.verification
    || execution.verification?.verification
    || execution.verification
    || null;
}

function verificationPassed(verification) {
  if (!verification) return null;
  const status = String(verification.status || "").toLowerCase();
  return verification.verified === true && status === "passed";
}

function normalizeExpression(value) {
  return String(value || "").replace(/[xX×]/g, "*").replace(/÷/g, "/").replace(/\s+/g, "");
}

function extractArithmeticExpression(step) {
  const match = normalizeExpression(step).match(/-?\d+(?:\.\d+)?(?:[+\-*/]-?\d+(?:\.\d+)?)+/);
  return match?.[0] || "";
}

function calculateExpression(expression) {
  const tokens = String(expression || "").match(/-?\d+(?:\.\d+)?|[+\-*/]/g) || [];
  if (!tokens.length || tokens.join("") !== expression) return null;
  const values = [];
  const operators = [];
  const precedence = { "+": 1, "-": 1, "*": 2, "/": 2 };
  const apply = () => {
    const operator = operators.pop();
    const right = values.pop();
    const left = values.pop();
    if (![left, right].every(Number.isFinite)) return false;
    if (operator === "+") values.push(left + right);
    else if (operator === "-") values.push(left - right);
    else if (operator === "*") values.push(left * right);
    else if (operator === "/" && right !== 0) values.push(left / right);
    else return false;
    return true;
  };
  for (const token of tokens) {
    if (/^-?\d/.test(token)) values.push(Number(token));
    else {
      while (operators.length && precedence[operators.at(-1)] >= precedence[token]) {
        if (!apply()) return null;
      }
      operators.push(token);
    }
  }
  while (operators.length) if (!apply()) return null;
  return values.length === 1 && Number.isFinite(values[0]) ? values[0] : null;
}

function containsExpectedResult(message, expected) {
  const escaped = String(expected).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = `(?:${escaped}(?:\.0+)?)`;
  return new RegExp(`(?:=|等于|结果(?:是|为)?|答案(?:是|为)?)\\s*${value}(?!\\d)|^\\s*${value}\\s*$`, "i").test(String(message || ""));
}

function claimsToolExecution(message) {
  const text = String(message || "");
  return /(?:已|成功|通过|使用|调用了).{0,16}(?:工具|计算器|calculator)|(?:工具|计算器|calculator).{0,16}(?:已执行|执行成功|调用完成|真实执行)|本地.{0,8}真实(?:计算|执行)/i.test(text);
}

function toolResultPassed(result) {
  if (!result || result.success === false || String(result.status || "").toLowerCase() === "failed") return false;
  const verification = embeddedVerification(result);
  return verification ? verificationPassed(verification) === true : result.success === true;
}

function verifyWritingContract(step, message, toolResults = []) {
  if (!/(?:论文|文章|短文)/i.test(step)) return null;
  const targetLength = Number((String(step).match(/(\d{2,5})\s*字/) || [])[1] || 100);
  const readable = String(message || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[#>*_`|\-]/g, "")
    .replace(/\s+/g, "")
    .trim();
  const characterCount = [...readable].length;
  const minimum = Math.max(40, Math.floor(targetLength * 0.6));
  const maximum = Math.max(minimum + 20, Math.ceil(targetLength * 2.2));
  const lengthPassed = characterCount >= minimum && characterCount <= maximum;
  const subjectPassed = /人工智能|AI|大模型|算法|智能/i.test(readable);
  const toolEvidencePassed = !toolResults.length || toolResults.every(toolResultPassed);
  const passed = lengthPassed && subjectPassed && toolEvidencePassed;
  return {
    verified: passed,
    status: passed ? "passed" : "failed",
    source: "content_contract",
    reason: passed ? "" : !lengthPassed
      ? `论文正文长度未通过验证：实际${characterCount}字，要求${minimum}-${maximum}字`
      : !subjectPassed ? "论文内容未体现指定的AI主题" : "论文相关工具执行存在失败记录",
    checks: [
      { name: "content_length", passed: lengthPassed, expected: targetLength, actual: characterCount },
      { name: "ai_subject", passed: subjectPassed },
      { name: "tool_evidence", passed: toolEvidencePassed, count: toolResults.length }
    ],
    evidence: { targetLength, minimum, maximum, characterCount, toolResultCount: toolResults.length }
  };
}

function verifyAgentExecution({ step = "", execution = {} } = {}) {
  const message = String(execution.message || execution.text || execution.error || "").trim();
  const toolResults = Array.isArray(execution.toolResults) ? execution.toolResults : [];
  const claimedToolExecution = claimsToolExecution(message);
  const existing = embeddedVerification(execution);
  const existingPassed = verificationPassed(existing);

  if (execution.success !== true) {
    return { verified: false, status: "failed", source: "execution", reason: execution.error || message || "子 Agent 执行失败", checks: [{ name: "execution_success", passed: false }] };
  }
  if (existing && existingPassed !== true) {
    return { ...existing, verified: false, status: "failed", source: existing.source || "execution_verifier", reason: existing.reason || "执行结果未通过已有验证" };
  }

  const expression = extractArithmeticExpression(step);
  if (expression) {
    const expected = calculateExpression(expression);
    const matched = expected !== null && containsExpectedResult(message, expected);
    const claimCorrected = claimedToolExecution && toolResults.length === 0;
    return {
      verified: matched,
      status: matched ? "passed" : "failed",
      source: "deterministic_arithmetic",
      reason: matched ? "" : `算术结果未通过确定性校验，期望结果为 ${expected}`,
      checks: [
        { name: "expression_parsed", passed: expected !== null, expression },
        { name: "result_matches", passed: matched, expected },
        { name: "tool_claim_supported", passed: !claimedToolExecution || toolResults.length > 0, corrected: claimCorrected }
      ],
      evidence: { expression, expected, claimedToolExecution, toolResultCount: toolResults.length },
      correctedMessage: claimCorrected && matched
        ? `确定性校验通过：${expression}=${expected}。未检测到工具调用记录，模型的工具调用声明不作为证据。`
        : ""
    };
  }

  if (claimedToolExecution && toolResults.length === 0) {
    return {
      verified: false,
      status: "failed",
      source: "tool_evidence",
      reason: "结果声称调用工具，但没有任何真实工具执行记录",
      checks: [{ name: "tool_claim_supported", passed: false }],
      evidence: { claimedToolExecution: true, toolResultCount: 0 }
    };
  }
  const writingContract = verifyWritingContract(step, message, toolResults);
  if (writingContract) return writingContract;
  if (existingPassed === true) {
    return { ...existing, verified: true, status: "passed", source: existing.source || "execution_verifier" };
  }
  if (toolResults.length) {
    const passed = toolResults.every(toolResultPassed);
    return {
      verified: passed,
      status: passed ? "passed" : "failed",
      source: "tool_results",
      reason: passed ? "" : "至少一个工具执行结果未通过验证",
      checks: toolResults.map((result, index) => ({ name: `tool_result_${index + 1}`, passed: toolResultPassed(result) })),
      evidence: { toolResultCount: toolResults.length }
    };
  }
  return {
    verified: false,
    status: "failed",
    source: "missing_evidence",
    reason: "没有独立验证结果或真实工具执行证据",
    checks: [{ name: "independent_evidence", passed: false }]
  };
}

module.exports = { calculateExpression, claimsToolExecution, extractArithmeticExpression, verifyAgentExecution, verifyWritingContract };
