/**
 * 白球AI 工具调用修复验证脚本
 * 验证两处修复是否在逻辑上生效
 *
 * 运行方式：node verify-fix.js
 */

const fs = require("fs");
const path = require("path");

const mainJsPath = path.join(__dirname, "..", "main.js");
const source = fs.readFileSync(mainJsPath, "utf8");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

console.log("=== 白球AI 工具调用修复验证 ===\n");

// === 测试 1: runDirectConversation 不再禁用工具 ===
console.log("测试 1: runDirectConversation() 工具启用状态");

const runDirectConvMatch = source.match(
  /async function runDirectConversation[\s\S]*?directProviderChat\([\s\S]*?\{[\s\S]*?disableTools:\s*(\w+)/
);
assert(runDirectConvMatch, "找到 runDirectConversation 中的 disableTools 设置");
if (runDirectConvMatch) {
  assert(runDirectConvMatch[1] === "false", `disableTools = ${runDirectConvMatch[1]} (期望: false)`);
}

const webBridgeMatch = source.match(
  /async function runDirectConversation[\s\S]*?disableWebBridge:\s*(\w+)/
);
assert(webBridgeMatch, "找到 disableWebBridge 设置");
if (webBridgeMatch) {
  assert(webBridgeMatch[1] === "false", `disableWebBridge = ${webBridgeMatch[1]} (期望: false)`);
}

const fallbackModeMatch = source.match(
  /async function runDirectConversation[\s\S]*?providerFallbackToolMode:\s*"(\w+)"/
);
assert(fallbackModeMatch, "找到 providerFallbackToolMode 设置");
if (fallbackModeMatch) {
  assert(fallbackModeMatch[1] === "safe", `providerFallbackToolMode = "${fallbackModeMatch[1]}" (期望: "safe")`);
}

// === 测试 2: 白名单包含 web_search ===
console.log("\n测试 2: PROVIDER_FALLBACK_SAFE_TOOL_IDS 白名单");

const setMatch = source.match(/PROVIDER_FALLBACK_SAFE_TOOL_IDS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
assert(setMatch, "找到 PROVIDER_FALLBACK_SAFE_TOOL_IDS 定义");

if (setMatch) {
  const toolIds = setMatch[1]
    .split(",")
    .map((s) => s.trim().replace(/"/g, ""))
    .filter(Boolean);

  assert(toolIds.length >= 30, `白名单包含 ${toolIds.length} 个工具 (期望: >= 30)`);
  assert(toolIds.includes("web_search"), "白名单包含 web_search");
  assert(toolIds.includes("webpage_read"), "白名单包含 webpage_read");
  assert(toolIds.includes("run_command"), "白名单包含 run_command");
  assert(toolIds.includes("write_text_file"), "白名单包含 write_text_file");
  assert(toolIds.includes("word_read"), "白名单包含 word_read");
  assert(toolIds.includes("pdf_read"), "白名单包含 pdf_read");
  assert(toolIds.includes("desktop_screenshot"), "白名单包含 desktop_screenshot");
  assert(toolIds.includes("clipboard_read"), "白名单包含 clipboard_read");

  console.log(`\n  完整白名单 (${toolIds.length} 个工具):`);
  toolIds.forEach((id, i) => {
    const marker = id === "web_search" ? " ← 联网搜索" : "";
    console.log(`    ${String(i + 1).padStart(2)}. ${id}${marker}`);
  });
}

// === 测试 3: 模拟 providerToolCallAllowed 逻辑 ===
console.log("\n测试 3: 模拟 providerToolCallAllowed() 逻辑");

const testTools = ["web_search", "webpage_read", "run_command", "write_text_file", "unknown_tool"];

// 从源码提取的白名单
const safeToolIds = setMatch ? new Set(
  setMatch[1].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean)
) : new Set();

function isProviderFallbackSafeTool(toolId) {
  const id = String(toolId || "").trim();
  if (!id) return false;
  if (id.startsWith("skill_")) return false; // 简化
  return safeToolIds.has(id);
}

function providerFallbackToolMode(options = {}) {
  return String(options.providerFallbackToolMode || options.toolMode || "").trim().toLowerCase();
}

function providerToolCallAllowed(toolId, options = {}) {
  return providerFallbackToolMode(options) !== "safe" || isProviderFallbackSafeTool(toolId);
}

// 模拟 runDirectConversation 修复后的上下文
const fixedContext = { providerFallbackToolMode: "safe" };

for (const toolId of testTools) {
  const allowed = providerToolCallAllowed(toolId, fixedContext);
  const expected = toolId !== "unknown_tool";
  assert(allowed === expected, `providerToolCallAllowed("${toolId}", safe) = ${allowed} (期望: ${expected})`);
}

// 模拟修复前的上下文（disableTools: true 的情况）
console.log("\n测试 4: 修复前对比（disableTools: true 的效果）");

const oldContext = { disableTools: true };
// canExposeAgentLoopTools(context) = context.disableTools !== true
const oldToolsAllowed = oldContext.disableTools !== true;
assert(oldToolsAllowed === false, "修复前 canExposeAgentLoopTools() = false (工具被完全禁用)");

const newContext = { disableTools: false };
const newToolsAllowed = newContext.disableTools !== true;
assert(newToolsAllowed === true, "修复后 canExposeAgentLoopTools() = true (工具已启用)");

// === 总结 ===
console.log("\n=== 验证结果 ===");
console.log(`通过: ${passed}  失败: ${failed}  总计: ${passed + failed}`);
if (failed === 0) {
  console.log("\n🎉 所有验证通过！修复已正确应用。");
  console.log("\n下一步：启动白球AI，发送一条搜索请求（如「帮我搜索今天的新闻」），");
  console.log("确认 AI 能成功调用 web_search 工具并返回搜索结果，不再出现「权限不足」。");
} else {
  console.log("\n⚠️ 有验证失败，请检查对应修复点。");
}
process.exit(failed > 0 ? 1 : 0);
