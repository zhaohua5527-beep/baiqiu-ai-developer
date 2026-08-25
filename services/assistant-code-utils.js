(function exposeAssistantCodeUtils(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.BaiqiuAssistantCodeUtils = api;
})(typeof window !== "undefined" ? window : globalThis, () => {
  const CODE_BLOCK_PATTERN = /```([a-zA-Z0-9_-]*)\s*\n?([\s\S]*?)```/g;
  const IMPLICIT_CODE_PATTERN = /(?:^|\n)([ \t]*(?:(?:export\s+)?(?:interface|class|type|enum|namespace|const|let|var|function)\s+[A-Za-z_$][\w$]*|import\s+[^\n]+|from\s+\S+\s+import\s+[^\n]+|def\s+[A-Za-z_]\w*\s*\(|async\s+[A-Za-z_$][\w$]*\s*\([^\n]*\)\s*(?::[^\n{]+)?\s*\{|(?:public|private|protected|static)\s+[A-Za-z_$][\w$]*\s*\()[\s\S]*)$/i;
  const HIDDEN_CODE_LABEL = "（代码内容已隐藏，可点击展开或直接复制。）";
  const PROGRAMMING_LANGUAGES = new Set(["bash", "c", "cpp", "csharp", "css", "go", "html", "java", "javascript", "js", "json", "jsx", "php", "powershell", "ps1", "py", "python", "rb", "rust", "sh", "shell", "sql", "ts", "tsx", "typescript", "xml", "yaml", "yml"]);

  function escapeRegex(value = "") {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function escapeTableCell(value = "") {
    return String(value || "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
  }

  function tableMarkdownFromBlock(language = "", content = "") {
    const kind = String(language || "").trim().toLowerCase();
    if (PROGRAMMING_LANGUAGES.has(kind)) return "";
    const lines = String(content || "").replace(/\r/g, "").split("\n").filter((line) => line.trim());
    if (lines.length < 2) return "";
    const markdownDivider = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/;
    if (lines[0].includes("|") && markdownDivider.test(lines[1])) return lines.join("\n").trim();
    const rows = lines.map((line) => line.split("\t").map(escapeTableCell));
    const width = rows[0]?.length || 0;
    if (width < 2 || rows.some((row) => row.length !== width)) return "";
    const header = rows[0];
    return [
      `| ${header.join(" | ")} |`,
      `| ${header.map(() => "---").join(" | ")} |`,
      ...rows.slice(1).map((row) => `| ${row.join(" | ")} |`)
    ].join("\n");
  }

  function normalizeFencedTables(text = "") {
    return String(text || "").replace(CODE_BLOCK_PATTERN, (match, language, content) => {
      const markdown = tableMarkdownFromBlock(language, content);
      return markdown ? `\n${markdown}\n` : match;
    });
  }

  function prepareAssistantMarkdownSource(text = "") {
    const normalized = String(text || "")
      .replace(/<\s*(?:strong|b)\s*>/gi, "**")
      .replace(/<\s*\/\s*(?:strong|b)\s*>/gi, "**")
      .replace(/<\s*(?:em|i)\s*>/gi, "*")
      .replace(/<\s*\/\s*(?:em|i)\s*>/gi, "*")
      .replace(/<\s*br\s*\/?\s*>/gi, "\n");

    // Escape provider HTML without escaping Markdown's own blockquote marker.
    return normalized.replace(/<(?:!--[\s\S]*?--|\/?[A-Za-z][\s\S]*?)>/g, (tag) => tag
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;"));
  }

  function isTableCodeBlock(block = {}) {
    return Boolean(tableMarkdownFromBlock(block.language, block.code));
  }

  function restoreHiddenTableBlocks(text = "", blocks = []) {
    let index = 0;
    const pattern = new RegExp(escapeRegex(HIDDEN_CODE_LABEL), "g");
    return String(text || "").replace(pattern, (label) => {
      const block = Array.isArray(blocks) ? blocks[index] : null;
      index += 1;
      const markdown = block ? tableMarkdownFromBlock(block.language, block.code) : "";
      return markdown ? `\n${markdown}\n` : label;
    });
  }

  function extractCodeBlocks(text) {
    const blocks = [];
    const source = normalizeFencedTables(text);
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
    return normalizeFencedTables(text)
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

  function createAssistantMarkdownRenderer(Renderer) {
    if (typeof Renderer !== "function") return null;
    const renderer = new Renderer();
    renderer.del = function renderTildeAwareDeletion({ raw = "", tokens = [] } = {}) {
      const content = this.parser.parseInline(tokens);
      return String(raw).startsWith("~~") ? `<del>${content}</del>` : `~${content}~`;
    };
    return renderer;
  }

  return {
    HIDDEN_CODE_LABEL,
    createAssistantMarkdownRenderer,
    extractCodeBlocks,
    hideCodeBlocks,
    hideInternalToolOutput,
    isTableCodeBlock,
    normalizeFencedTables,
    prepareAssistantMarkdownSource,
    restoreHiddenTableBlocks,
    tableMarkdownFromBlock
  };
});
