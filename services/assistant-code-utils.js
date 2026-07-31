(function exposeAssistantCodeUtils(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.BaiqiuAssistantCodeUtils = api;
})(typeof window !== "undefined" ? window : globalThis, () => {
  const CODE_BLOCK_PATTERN = /```([a-zA-Z0-9_-]*)\s*\n?([\s\S]*?)```/g;
  const IMPLICIT_CODE_PATTERN = /(?:^|\n)([ \t]*(?:(?:export\s+)?(?:interface|class|type|enum|namespace|const|let|var|function)\s+[A-Za-z_$][\w$]*|import\s+[^\n]+|from\s+\S+\s+import\s+[^\n]+|def\s+[A-Za-z_]\w*\s*\(|async\s+[A-Za-z_$][\w$]*\s*\([^\n]*\)\s*(?::[^\n{]+)?\s*\{|(?:public|private|protected|static)\s+[A-Za-z_$][\w$]*\s*\()[\s\S]*)$/i;
  const HIDDEN_CODE_LABEL = "（代码内容已隐藏，可点击展开或直接复制。）";

  function extractCodeBlocks(text) {
    const blocks = [];
    const source = String(text || "");
    const withoutFenced = source.replace(CODE_BLOCK_PATTERN, (_match, language, code) => {
      blocks.push({
        language: String(language || "代码").trim() || "代码",
        code: String(code || "").replace(/\s+$/, "")
      });
      return "\n";
    });
    const implicit = withoutFenced.match(IMPLICIT_CODE_PATTERN);
    if (implicit?.[1]) {
      const code = implicit[1].trimEnd();
      blocks.push({
        language: /(?:interface|type\s+\w+\s*=|:\s*(?:string|number|boolean|Promise<))/i.test(code) ? "typescript" : "代码",
        code
      });
    }
    return blocks;
  }

  function hideCodeBlocks(text) {
    return String(text || "")
      .replace(CODE_BLOCK_PATTERN, HIDDEN_CODE_LABEL)
      .replace(IMPLICIT_CODE_PATTERN, `\n${HIDDEN_CODE_LABEL}`)
      .replace(new RegExp(`(?:${HIDDEN_CODE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*){2,}`, "g"), HIDDEN_CODE_LABEL);
  }

  function hideInternalToolOutput(text) {
    const lines = String(text || "").split(/\r?\n/);
    const cutoff = lines.findIndex((line) => /^\s*(?:命令退出码|输出摘要|提示信息)\s*[:：]/.test(line));
    const visible = (cutoff >= 0 ? lines.slice(0, cutoff) : lines)
      .filter((line) => !/^\s*(?:={3,}\s*[^=]+\s*={3,}|\[(?:FILE|DIR)\]\s+|(?:stdout|stderr|exitCode|returnValue)\s*[:：])/i.test(line))
      .join("\n")
      .replace(/工具执行已停止[:：]/g, "执行已停止：")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return visible;
  }

  return { HIDDEN_CODE_LABEL, extractCodeBlocks, hideCodeBlocks, hideInternalToolOutput };
});
