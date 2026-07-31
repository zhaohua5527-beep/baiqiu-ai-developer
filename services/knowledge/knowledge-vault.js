const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

const CATEGORIES = Object.freeze([
  { id: "core", label: "核心项目" },
  { id: "assets", label: "沉淀资产" },
  { id: "resources", label: "外部资源" },
  { id: "archive", label: "归档内容" },
  { id: "ideas", label: "灵感库" },
  { id: "templates", label: "技能模板" }
]);

function text(value) {
  return String(value ?? "").trim();
}

function categoryId(value) {
  const id = text(value).toLowerCase();
  return CATEGORIES.some((item) => item.id === id) ? id : "core";
}

function tags(value) {
  const list = Array.isArray(value) ? value : text(value).split(/[,，、\n]/);
  return [...new Set(list.map((item) => text(item)).filter(Boolean))].slice(0, 20);
}

function safeName(value) {
  return text(value).replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").slice(0, 64) || "未命名知识";
}

function parseMarkdown(raw) {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/.exec(String(raw || ""));
  if (!match) return { meta: {}, body: String(raw || "") };
  try { return { meta: YAML.parse(match[1]) || {}, body: match[2] || "" }; }
  catch { return { meta: {}, body: match[2] || "" }; }
}

function formatMarkdown(meta, body) {
  const now = new Date().toISOString();
  const title = text(meta.title) || "未命名知识";
  const frontMatter = YAML.stringify({
    title,
    category: categoryId(meta.category),
    tags: tags(meta.tags),
    createdAt: text(meta.createdAt) || now,
    updatedAt: text(meta.updatedAt) || now
  }).trimEnd();
  const content = text(body) || `# ${title}\n\n`;
  return `---\n${frontMatter}\n---\n\n${content}\n`;
}

class KnowledgeVault {
  constructor({ rootProvider }) {
    this.rootProvider = rootProvider;
  }

  root() {
    const root = path.resolve(this.rootProvider());
    const knowledgeRoot = path.join(root, "knowledge");
    fs.mkdirSync(knowledgeRoot, { recursive: true });
    for (const item of CATEGORIES) fs.mkdirSync(path.join(knowledgeRoot, item.id), { recursive: true });
    return knowledgeRoot;
  }

  idFor(file) {
    return path.relative(this.root(), file).replace(/\\/g, "/");
  }

  fileFor(id) {
    const root = this.root();
    const file = path.resolve(root, String(id || "").replace(/^[/\\]+/, ""));
    if (!/\.md$/i.test(file) || (file !== root && !file.startsWith(`${root}${path.sep}`))) throw new Error("知识条目路径无效");
    return file;
  }

  digest(file) {
    const stat = fs.statSync(file);
    const parsed = parseMarkdown(fs.readFileSync(file, "utf8"));
    const relative = this.idFor(file).split("/");
    const category = categoryId(parsed.meta.category || relative[0]);
    const title = text(parsed.meta.title) || path.basename(file, ".md") || "未命名知识";
    const body = String(parsed.body || "");
    const knowledgeUnits = body.replace(/\s+/g, "").length;
    const level = Math.min(9, Math.floor(knowledgeUnits / 400) + 1);
    const progress = level >= 9 ? 100 : Math.round((knowledgeUnits % 400) / 4);
    return {
      id: this.idFor(file),
      title,
      category,
      categoryLabel: CATEGORIES.find((item) => item.id === category)?.label || "核心项目",
      tags: tags(parsed.meta.tags),
      createdAt: text(parsed.meta.createdAt) || new Date(stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs).toISOString(),
      updatedAt: text(parsed.meta.updatedAt) || stat.mtime.toISOString(),
      filePath: file,
      pathLabel: file,
      byteSize: stat.size,
      knowledgeUnits,
      level,
      progress,
      excerpt: body.replace(/^#\s+.*(?:\r?\n|$)/, "").replace(/\s+/g, " ").trim().slice(0, 160)
    };
  }

  files() {
    const result = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && /\.md$/i.test(entry.name)) result.push(file);
      }
    };
    walk(this.root());
    return result;
  }

  state() {
    const scanErrors = [];
    const notes = this.files().map((file) => {
      try { return this.digest(file); }
      catch (error) {
        scanErrors.push({ filePath: file, error: error.message || String(error) });
        return null;
      }
    }).filter(Boolean)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    const counts = Object.fromEntries(CATEGORIES.map((item) => [item.id, 0]));
    for (const note of notes) counts[note.category] = (counts[note.category] || 0) + 1;
    return {
      root: this.root(),
      total: notes.length,
      totalKnowledgeUnits: notes.reduce((sum, note) => sum + Number(note.knowledgeUnits || 0), 0),
      totalBytes: notes.reduce((sum, note) => sum + Number(note.byteSize || 0), 0),
      scanErrors,
      latestUpdatedAt: notes[0]?.updatedAt || "",
      categories: CATEGORIES.map((item) => ({ ...item, count: counts[item.id] || 0 })),
      notes
    };
  }

  unique(file) {
    if (!fs.existsSync(file)) return file;
    const ext = path.extname(file);
    const base = file.slice(0, -ext.length);
    let index = 2;
    while (fs.existsSync(`${base}-${index}${ext}`)) index += 1;
    return `${base}-${index}${ext}`;
  }

  create(payload = {}) {
    const title = text(payload.title) || "未命名知识";
    const category = categoryId(payload.category);
    const stamp = new Date().toISOString().replace(/[T:-]/g, "").slice(0, 15);
    const file = this.unique(path.join(this.root(), category, `${stamp}-${safeName(title)}.md`));
    fs.writeFileSync(file, formatMarkdown({ title, category, tags: payload.tags }, payload.body || `# ${title}\n\n`), "utf8");
    return { note: this.digest(file), state: this.state() };
  }

  read(id) {
    const file = this.fileFor(id);
    if (!fs.existsSync(file)) throw new Error("知识条目不存在");
    const parsed = parseMarkdown(fs.readFileSync(file, "utf8"));
    return { note: this.digest(file), body: parsed.body || "", content: fs.readFileSync(file, "utf8") };
  }

  update(id, payload = {}) {
    const file = this.fileFor(id);
    const current = this.read(id);
    const category = categoryId(payload.category || current.note.category);
    const title = text(payload.title) || current.note.title;
    const target = category === current.note.category ? file : this.unique(path.join(this.root(), category, path.basename(file)));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, formatMarkdown({ title, category, tags: payload.tags ?? current.note.tags, createdAt: current.note.createdAt, updatedAt: new Date().toISOString() }, payload.body ?? current.body), "utf8");
    if (target !== file && fs.existsSync(file)) fs.unlinkSync(file);
    return { note: this.digest(target), state: this.state() };
  }

  remove(id) {
    const file = this.fileFor(id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return { ok: true, state: this.state() };
  }
}

module.exports = { KnowledgeVault, KNOWLEDGE_VAULT_CATEGORIES: CATEGORIES };
