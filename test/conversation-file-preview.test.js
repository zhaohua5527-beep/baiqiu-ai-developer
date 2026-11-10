"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const root = path.join(__dirname, "..");
const renderer = fs.readFileSync(path.join(root, "renderer-v2/app.js"), "utf8");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const between = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
};

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; }
  get isConnected() { return this.root === true || Boolean(this.parentElement?.isConnected); }
  appendChild(node) { this.children.push(node); node.parentElement = this; }
  replaceChildren(...nodes) {
    this.children.forEach(node => { node.parentElement = null; });
    this.children = [];
    nodes.forEach(node => this.appendChild(node));
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  querySelector() { return this.children.find(node => node.className === "conversation-file-preview") || null; }
  closest() { return this.className === "bubble" ? this : this.parentElement?.closest() || null; }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this);
    this.parentElement = null;
  }
}

function viewFixture(previewAttachment) {
  const bubble = new Element("div");
  bubble.className = "bubble";
  bubble.root = true;
  const rendered = new Element("div");
  bubble.appendChild(rendered);
  const context = vm.createContext({ URL, document: { createElement: tag => new Element(tag) },
    api: { previewAttachment }, showCopyToast() {} });
  vm.runInContext(between(renderer, "function localFilePathFromHref(", "function bindConversationFileLink("), context);
  return { bubble, rendered, context, open: value => context.openConversationFilePreview(rendered, value) };
}

test("Word links request the exact file and display a labeled content preview", async () => {
  const calls = [];
  const view = viewFixture(async file => { calls.push(file); return { ok: true, kind: "document", previewText: "<script>not executed</script>" }; });
  await view.open("C:/Users/客户/活动方案.docx");
  assert.equal(calls[0].strictPath, true);
  assert.equal(calls[0].sourcePath, "C:/Users/客户/活动方案.docx");
  const panel = view.bubble.querySelector();
  assert.equal(panel.children[0].children[0].textContent, "活动方案.docx");
  const content = panel.children[1];
  assert.match(content.children[0].textContent, /原始排版/);
  assert.equal(content.children[1].textContent, "<script>not executed</script>");
  assert.equal(content.children[1].innerHTML, undefined);
});

test("PDF uses the existing local viewer without replacing the conversation", async () => {
  const view = viewFixture(async () => ({ ok: true, kind: "frame", fileUrl: "file:///C:/report.pdf" }));
  await view.open("C:/report.pdf");
  const frame = view.bubble.querySelector().children[1].children[0];
  assert.equal(frame.tagName, "iframe");
  assert.equal(frame.src, "file:///C:/report.pdf");
  assert.equal(view.bubble.children[0], view.rendered);
});

test("late reads cannot overwrite a newer file or reopen a closed preview", async () => {
  const reads = [];
  const view = viewFixture(() => new Promise(resolve => reads.push(resolve)));
  const first = view.open("C:/first.docx");
  const second = view.open("C:/second.docx");
  reads[1]({ ok: true, kind: "document", previewText: "second" });
  await second;
  reads[0]({ ok: true, kind: "document", previewText: "first" });
  await first;
  assert.equal(view.bubble.querySelector().children[1].children[1].textContent, "second");
  const third = view.open("C:/third.docx");
  const panel = view.bubble.querySelector();
  await panel.children[0].children.at(-1).listeners.click();
  reads[2]({ ok: true, kind: "document", previewText: "third" });
  await third;
  assert.equal(view.bubble.querySelector(), null);
});

test("file errors and unsupported formats are visible rather than blank previews", async () => {
  const view = viewFixture(async () => { throw new Error("文件不存在或已移动"); });
  await view.open("C:/missing.docx");
  assert.match(view.bubble.querySelector().children[1].textContent, /不存在/);
  const unsupported = viewFixture(async () => ({ ok: false, previewText: "请打开原文件" }));
  await unsupported.open("C:/archive.zip");
  assert.equal(unsupported.bubble.querySelector().children[1].textContent, "请打开原文件");
});

test("file URLs decode local paths but never resolve a remote file host", () => {
  const { context } = viewFixture(async () => null);
  assert.equal(context.localFilePathFromHref("file:///C:/a%20b.docx"), "C:/a b.docx");
  assert.equal(context.localFilePathFromHref("file://remote/share/a.docx"), null);
  assert.equal(context.localFilePathFromHref("https://example.com/a.pdf"), null);
  assert.equal(context.localFilePathFromHref("file:///C:/bad%ZZ.docx"), null);
});

function backendFixture({ missing = false, size = 1024 } = {}) {
  let reads = 0;
  const context = vm.createContext({ path: path.win32, pathToFileURL, Buffer,
    fs: { promises: {
      stat: async () => { if (missing) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return { size, isFile: () => true }; },
      readFile: async () => { reads++; return Buffer.from("<script>unsafe HTML</script>"); }
    } },
    resolvePreviewAttachmentPath() { throw new Error("exact file must not fall back to a same-name file"); },
    mammothParser: () => ({ extractRawText: async () => ({ value: "Word text", messages: [] }) })
  });
  vm.runInContext(between(main, "async function resolveConversationPreviewFile(", "function isPrivatePreviewAddress("), context);
  return { preview: file => context.previewAttachmentData({ sourcePath: file, strictPath: true }), reads: () => reads };
}

test("strict file resolution never falls back and PDFs do not buffer the full file", async () => {
  const pdf = backendFixture({ size: 100 * 1024 * 1024 });
  assert.equal((await pdf.preview("C:/document.pdf")).kind, "frame");
  assert.equal(pdf.reads(), 0);
  await assert.rejects(backendFixture({ missing: true }).preview("C:/missing.docx"), /不存在/);
  await assert.rejects(pdf.preview("relative.docx"), /完整路径/);
  await assert.rejects(pdf.preview("//remote/share/doc.docx"), /完整路径/);
  assert.equal((await pdf.preview("C:/large.docx")).kind, "large");
  assert.equal(pdf.reads(), 0);
});

test("HTML is plain text and unsupported files are never executed or eagerly read", async () => {
  const backend = backendFixture();
  const html = await backend.preview("C:/sample.html");
  assert.equal(html.kind, "text");
  assert.equal(html.previewText, "<script>unsafe HTML</script>");
  assert.equal((await backend.preview("C:/program.exe")).kind, "binary");
  assert.equal(backend.reads(), 1);
});
