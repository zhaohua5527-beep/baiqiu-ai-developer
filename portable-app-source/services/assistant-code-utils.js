(function exposeAssistantCodeUtils(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.BaiqiuAssistantCodeUtils = api;
})(typeof window !== "undefined" ? window : globalThis, () => {
  const CODE_BLOCK_PATTERN = /```([a-zA-Z0-9_-]*)\s*\n?([\s\S]*?)```/g;
  const IMPLICIT_CODE_PATTERN = /(?:^|\n)([ \t]*(?:(?:export\s+)?(?:interface|class|type|enum|namespace|const|let|var|function)\s+[A-Za-z_$][\w$]*|import\s+[^\n]+|from\s+\S+\s+import\s+[^\n]+|def\s+[A-Za-z_]\w*\s*\(|async\s+[A-Za-z_$][\w$]*\s*\([^\n]*\)\s*(?::[^\n{]+)?\s*\{|(?:public|private|protected|static)\s+[A-Za-z_$][\w$]*\s*\()[\s\S]*)$/i;
  const HIDDEN_CODE_LABEL = "（代码内容已隐藏，可点击展开或直接复制。）";
  const PROGRAMMING_LANGUAGES = new Set(["bash", "c", "cpp", "csharp", "css", "go", "html", "java", "javascript", "js", "json", "jsx", "php", "powershell", "ps1", "py", "python", "rb", "rust", "sh", "shell", "sql", "ts", "tsx", "typescript", "xml", "yaml", "yml"]);
  const PREVIEW_LANGUAGES = new Set(["html", "htm", "svg"]);
  const CODE_BLOCK_KIND_BY_LANGUAGE = new Map([
    ...["bash", "bat", "batch", "cmd", "powershell", "ps1", "sh", "shell", "zsh"].map((language) => [language, "command"]),
    ...["json", "jsonc"].map((language) => [language, "json"]),
    ...["diff", "patch"].map((language) => [language, "diff"]),
    ...["console", "log", "logs", "output", "stderr", "stdout"].map((language) => [language, "log"]),
    ...["baiqiu-evidence", "evidence"].map((language) => [language, "evidence"]),
    ...["plain", "plaintext", "text", "txt"].map((language) => [language, "text"]),
    ...["md", "markdown"].map((language) => [language, "document"]),
    ...["dot", "flowchart", "graphviz", "mermaid", "mindmap"].map((language) => [language, "diagram"])
  ]);

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

  function codePreviewKind(language = "", code = "") {
    const kind = String(language || "").trim().toLowerCase();
    if (!PREVIEW_LANGUAGES.has(kind) || !String(code || "").trim()) return "";
    return kind === "svg" ? "svg" : "html";
  }

  function codeBlockKind(language = "") {
    const kind = String(language || "").trim().toLowerCase();
    return CODE_BLOCK_KIND_BY_LANGUAGE.get(kind) || "code";
  }

  function buildSafeCodePreview(language = "", code = "") {
    const kind = codePreviewKind(language, code);
    if (!kind) return "";
    const body = kind === "svg" ? `<div class="baiqiu-svg-preview">${String(code || "")}</div>` : String(code || "");
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:;"><style>html,body{margin:0;min-height:100%;background:#fff;color:#17202b;font:14px system-ui,sans-serif}body{padding:18px;box-sizing:border-box}.baiqiu-svg-preview{display:grid;place-items:center;min-height:120px}.baiqiu-svg-preview>svg{max-width:100%;height:auto}</style></head><body>${body}</body></html>`;
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
      .replace(IMPLICIT_CODE_PATTERN, `\n${HIDDEN_CODE_LABEL}`);
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

  function createAssistantMarkdownTokenizer(Tokenizer) {
    if (typeof Tokenizer !== "function") return undefined;
    const tokenizer = new Tokenizer();
    const original = tokenizer.emStrong;
    tokenizer.emStrong = function cjkEmphasis(source, maskedSource, previousCharacter) {
      const standard = original.call(this, source, maskedSource, previousCharacter);
      if (standard) return standard;
      const match = /^\*\*(?!\*)(\S(?:[^\n]*?\S)?)\*\*(?!\*)/.exec(source);
      if (!match || match[1].includes("**") || /\\$/.test(match[1])) return;
      const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
      const after = source.slice(match[0].length, match[0].length + 1);
      if (!(cjk.test(after) && /[\p{P}\p{S}]$/u.test(match[1]))
        && !(cjk.test(previousCharacter || "") && /^[\p{P}\p{S}]/u.test(match[1]))) return;
      return { type: "strong", raw: match[0], text: match[1], tokens: this.lexer.inlineTokens(match[1]) };
    };
    return tokenizer;
  }

  return {
    HIDDEN_CODE_LABEL,
    codeBlockKind,
    createAssistantMarkdownRenderer,
    createAssistantMarkdownTokenizer,
    buildSafeCodePreview,
    codePreviewKind,
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
