(function exposeResultAst(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.BaiqiuResultAst = api;
})(typeof window !== "undefined" ? window : globalThis, () => {
  const BLOCK_TYPES = Object.freeze({
    heading: "Heading",
    paragraph: "Paragraph",
    list: "List",
    blockquote: "Blockquote",
    code: "CodeBlock",
    table: "Table"
  });

  const INLINE_TYPES = Object.freeze({
    text: "Text",
    strong: "Strong",
    em: "Emphasis",
    codespan: "InlineCode",
    link: "Link",
    image: "Image"
  });

  function nodeBase(type, token = {}, extra = {}) {
    return {
      type,
      raw: String(token.raw || ""),
      semanticRole: type.toLowerCase(),
      copyable: type !== "Document",
      copySerializer: type === "Table" ? "tsv" : (type === "CodeBlock" ? "code" : "plain-text"),
      ...extra
    };
  }

  function inlineNodes(tokens = []) {
    return (Array.isArray(tokens) ? tokens : []).map((token) => {
      const type = INLINE_TYPES[token?.type] || "Unknown";
      if (type === "Text" || type === "InlineCode") {
        return nodeBase(type, token, { text: String(token.text || "") });
      }
      if (type === "Image") {
        return nodeBase(type, token, {
          href: String(token.href || ""),
          title: String(token.title || ""),
          text: String(token.text || "")
        });
      }
      if (type === "Link") {
        return nodeBase(type, token, {
          href: String(token.href || ""),
          title: String(token.title || ""),
          children: inlineNodes(token.tokens)
        });
      }
      if (type === "Strong" || type === "Emphasis") {
        return nodeBase(type, token, { children: inlineNodes(token.tokens) });
      }
      if (token?.type === "br") return nodeBase("Text", token, { text: "\n" });
      return nodeBase("Unknown", token, {
        text: String(token?.text || token?.raw || ""),
        children: inlineNodes(token?.tokens)
      });
    });
  }

  function tableCell(cell = {}) {
    return nodeBase("TableCell", cell, {
      header: Boolean(cell.header),
      align: cell.align || null,
      children: inlineNodes(cell.tokens)
    });
  }

  function blockNode(token = {}) {
    const type = BLOCK_TYPES[token.type] || "Unknown";
    if (type === "Heading") {
      return nodeBase(type, token, {
        level: Math.max(1, Math.min(6, Number(token.depth || 1))),
        children: inlineNodes(token.tokens)
      });
    }
    if (type === "Paragraph") return nodeBase(type, token, { children: inlineNodes(token.tokens) });
    if (type === "CodeBlock") {
      return nodeBase(type, token, {
        language: String(token.lang || ""),
        text: String(token.text || "")
      });
    }
    if (type === "Blockquote") return nodeBase(type, token, { children: blockNodes(token.tokens) });
    if (type === "List") {
      return nodeBase(type, token, {
        ordered: Boolean(token.ordered),
        start: Number(token.start || 1),
        children: (token.items || []).map((item) => nodeBase("ListItem", item, {
          checked: typeof item.checked === "boolean" ? item.checked : null,
          children: blockNodes(item.tokens)
        }))
      });
    }
    if (type === "Table") {
      return nodeBase(type, token, {
        header: (token.header || []).map(tableCell),
        rows: (token.rows || []).map((row) => row.map(tableCell))
      });
    }
    return nodeBase("Unknown", token, {
      text: String(token.text || token.raw || ""),
      children: blockNodes(token.tokens)
    });
  }

  function blockNodes(tokens = []) {
    return (Array.isArray(tokens) ? tokens : [])
      .filter((token) => token?.type !== "space")
      .map(blockNode);
  }

  function createResultAst(markdown = "", options = {}) {
    if (String(options.target || "").trim().toLowerCase() !== "answer") return null;
    const source = String(markdown || "");
    const markedApi = options.marked;
    const lexer = markedApi?.lexer || markedApi?.marked?.lexer;
    if (typeof lexer !== "function") throw new TypeError("A marked lexer is required to create a Result AST.");
    const envelope = { ...(options.envelope || {}), target: "answer" };
    return {
      type: "Document",
      source,
      target: "answer",
      envelope,
      turnId: String(envelope.turnId || ""),
      eventId: String(envelope.eventId || ""),
      sequence: Number(envelope.sequence || 0),
      segmentId: String(envelope.segmentId || envelope.segment_id || ""),
      semanticRole: "document",
      copyable: true,
      copySerializer: "markdown",
      children: blockNodes(lexer(source, { gfm: true, breaks: true }))
    };
  }

  function plainText(node) {
    if (!node) return "";
    if (["Text", "InlineCode", "CodeBlock", "Unknown", "Image"].includes(node.type)) {
      return String(node.text || "");
    }
    if (node.type === "TableCell") return (node.children || []).map(plainText).join("");
    if (node.type === "Table") {
      return [node.header, ...(node.rows || [])]
        .map((row) => (row || []).map((cell) => plainText(cell).replace(/[\t\r\n]+/g, " ")).join("\t"))
        .join("\n");
    }
    if (node.type === "List") {
      return (node.children || []).map((item, index) => {
        const marker = node.ordered ? `${Number(node.start || 1) + index}.` : "-";
        return `${marker} ${plainText(item).trim()}`;
      }).join("\n");
    }
    if (node.type === "ListItem") return (node.children || []).map(plainText).join("\n");
    if (node.type === "Document") return (node.children || []).map(plainText).filter(Boolean).join("\n\n");
    return (node.children || []).map(plainText).join("");
  }

  function serializeResultNode(node, format = "plain-text") {
    const normalized = String(format || "plain-text").toLowerCase();
    if (normalized === "markdown") return String(node?.raw || node?.source || "");
    if (normalized === "code" && node?.type === "CodeBlock") return String(node.text || "");
    if (normalized === "tsv" && node?.type === "Table") return plainText(node);
    return plainText(node);
  }

  function serializeResult(document, format = "plain-text") {
    if (!document || document.type !== "Document" || document.target !== "answer") return "";
    if (String(format).toLowerCase() === "markdown") return String(document.source || "");
    return serializeResultNode(document, format);
  }

  return { createResultAst, serializeResult, serializeResultNode };
});
