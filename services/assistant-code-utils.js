(function exposeAssistantCodeUtils(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.BaiqiuAssistantCodeUtils = api;
})(typeof window !== "undefined" ? window : globalThis, () => {
  const CODE_BLOCK_PATTERN = /```([a-zA-Z0-9_-]*)\s*\n?([\s\S]*?)```/g;
  const IMPLICIT_CODE_PATTERN = /(?:^|\n)([ \t]*(?:(?:export\s+)?(?:interface|class|type|enum|namespace|const|let|var|function)\s+[A-Za-z_$][\w$]*|import\s+[^\n]+|from\s+\S+\s+import\s+[^\n]+|def\s+[A-Za-z_]\w*\s*\(|async\s+[A-Za-z_$][\w$]*\s*\([^\n]*\)\s*(?::[^\n{]+)?\s*\{|(?:public|private|protected|static)\s+[A-Za-z_$][\w$]*\s*\()[\s\S]*)$/i;
  const HIDDEN_CODE_LABEL = "（代码内容已隐藏，可点击展开或直接复制。）";
  const EVIDENCE_LANGUAGE = "baiqiu-evidence";
  const PROGRAMMING_LANGUAGES = new Set(["bash", "c", "cpp", "csharp", "css", "go", "html", "java", "javascript", "js", "json", "jsx", "php", "powershell", "ps1", "py", "python", "rb", "rust", "sh", "shell", "sql", "ts", "tsx", "typescript", "xml", "yaml", "yml"]);

  function escapeRegex(value = "") {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function escapeTableCell(value = "") {
    return String(value || "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
  }

  function tableMarkdownFromBlock(language = "", content = "") {
    const kind = String(language || "").trim().toLowerCase();
    if (kind === EVIDENCE_LANGUAGE) return "";
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

  function transformOutsideEvidence(text, transform, transformEvidence = (value) => value) {
    const source = String(text || "");
    const pattern = /^ {0,3}(`{3,}|~{3,})baiqiu-evidence[ \t]*\r?\n[\s\S]*?(?:^ {0,3}\1(?:`*|~*)[ \t]*(?:\r?\n|$)|(?![\s\S]))/gm;
    let result = "";
    let offset = 0;
    for (const match of source.matchAll(pattern)) {
      result += transform(source.slice(offset, match.index)) + transformEvidence(match[0]);
      offset = match.index + match[0].length;
    }
    return result + transform(source.slice(offset));
  }

  function transformOutsideFencedBlocks(text, transform) {
    const source = String(text || "");
    const pattern = /^ {0,3}(`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?^ {0,3}\1[ \t]*(?:\r?\n|$)/gm;
    let result = "";
    let offset = 0;
    for (const match of source.matchAll(pattern)) {
      result += transform(source.slice(offset, match.index)) + match[0];
      offset = match.index + match[0].length;
    }
    return result + transform(source.slice(offset));
  }

  function evidenceContext(text, start) {
    return String(text || "").slice(0, start).split(/\r?\n/).filter((line) => line.trim()).slice(-4).join(" ");
  }

  function looksLikeLegacyEvidenceContext(context, block = "") {
    const value = String(context || "").replace(/[*_`#]/g, "").trim();
    const content = String(block || "");
    const statusLines = content.match(/^\s*(?:OK|MISS)\b/gim) || [];
    if (/(?:代码|脚本|示例|实现|用法|配置如下)/i.test(value)) return false;
    return /(?:实测|实跑|核验|验证|证据|命令|输出|路径|版本|目录|确认|检查|空间|磁盘|执行结果)/i.test(value)
      || /^\d+[)）.、]\s+/.test(value)
      || statusLines.length >= 2
      || /(?:^|\n)\s*MISS\b/im.test(content)
      || /(?:exec-path|displayversion|sha-?256|校验和|总容量|可用空间|剩余空间)\s*[:=]/i.test(content);
  }

  function normalizeLegacyEvidenceBlocks(text = "") {
    const source = String(text || "");
    const pattern = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)\r?\n[\s\S]*?^\1\2[ \t]*(?:\r?\n|$)/gm;
    return source.replace(pattern, (block, indent, fence, language, _offset, fullSource) => {
      const kind = String(language || "").trim().toLowerCase();
      if (kind === EVIDENCE_LANGUAGE || !looksLikeLegacyEvidenceContext(evidenceContext(fullSource, _offset), block)) return block;
      const opening = `${indent}${fence}${EVIDENCE_LANGUAGE}`;
      return block.replace(new RegExp(`^${escapeRegex(indent + fence)}[^\\r\\n]*`, "m"), opening);
    });
  }

  function normalizeOrderedListMarkers(text = "") {
    const source = String(text || "");
    const pattern = /^( {0,3})(?:#{1,6}[ \t]+)?(\*\*)?(\d+)[)）](\s+)(.*?)(\*\*)?[ \t]*$/gm;
    return transformOutsideFencedBlocks(source, (value) => value.replace(pattern, (line, indent, boldStart, number, space, body, boldEnd) => {
      if (boldStart && boldEnd) return `${indent}${number}. **${body}**`;
      if (boldStart || boldEnd) return line;
      return `${indent}${number}.${space}${body}`;
    }));
  }

  function prepareAssistantMarkdownSource(text = "") {
    const withLegacyEvidence = normalizeLegacyEvidenceBlocks(text);
    return normalizeOrderedListMarkers(transformOutsideEvidence(withLegacyEvidence, prepareOrdinaryMarkdownSource));
  }

  function prepareOrdinaryMarkdownSource(text = "") {
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
    const source = normalizeFencedTables(transformOutsideEvidence(text, (value) => value, () => "\n"));
    const withoutFenced = source.replace(CODE_BLOCK_PATTERN, (_match, language, code) => {
      if (String(language).toLowerCase() === EVIDENCE_LANGUAGE) return "\n";
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
    return transformOutsideEvidence(text, (source) => normalizeFencedTables(source)
      .replace(CODE_BLOCK_PATTERN, HIDDEN_CODE_LABEL)
      .replace(IMPLICIT_CODE_PATTERN, `\n${HIDDEN_CODE_LABEL}`)
      .replace(new RegExp(`(?:${HIDDEN_CODE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*){2,}`, "g"), HIDDEN_CODE_LABEL));
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
    const renderCode = renderer.code;
    renderer.code = function renderEvidenceBlock(token) {
      if (String(token.lang || "").trim() !== EVIDENCE_LANGUAGE) return renderCode.call(this, token);
      const content = renderCode.call(this, { ...token, lang: "text", escaped: false });
      return `<details class="answer-evidence"><summary>展开</summary>${content}</details>\n`;
    };
    renderer.del = function renderTildeAwareDeletion({ raw = "", tokens = [] } = {}) {
      const content = this.parser.parseInline(tokens);
      return String(raw).startsWith("~~") ? `<del>${content}</del>` : `~${content}~`;
    };
    return renderer;
  }

  function attachEvidenceToPrecedingParagraph(root) {
    if (!root?.querySelectorAll) return 0;
    let attached = 0;
    for (const details of [...root.querySelectorAll("details.answer-evidence")]) {
      const paragraph = details.previousElementSibling;
      const tagName = paragraph?.tagName?.toLowerCase();
      if (!paragraph || !["p", "h1", "h2", "h3", "h4", "h5", "h6"].includes(tagName) || paragraph.parentElement?.classList.contains("answer-with-evidence")) continue;
      const wrapper = root.ownerDocument.createElement("div");
      wrapper.className = "answer-with-evidence";
      paragraph.replaceWith(wrapper);
      wrapper.append(paragraph, details);
      attached += 1;
    }
    return attached;
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
    attachEvidenceToPrecedingParagraph,
    createAssistantMarkdownRenderer,
    createAssistantMarkdownTokenizer,
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
