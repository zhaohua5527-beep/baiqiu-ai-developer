const fs = require("node:fs");
const path = require("node:path");

function loadTools(registry, context, toolsDir = path.join(__dirname, "tools")) {
  if (!fs.existsSync(toolsDir)) return [];
  const registered = [];
  const files = fs.readdirSync(toolsDir)
    .filter((file) => file.endsWith(".js"))
    .sort();

  for (const file of files) {
    const fullPath = path.join(toolsDir, file);
    delete require.cache[require.resolve(fullPath)];
    const mod = require(fullPath);
    const exportsValue = typeof mod.createTools === "function"
      ? mod.createTools(context)
      : typeof mod.createTool === "function"
        ? mod.createTool(context)
        : mod.tools || mod.tool || mod;
    const tools = Array.isArray(exportsValue) ? exportsValue : [exportsValue];
    for (const tool of tools.filter(Boolean)) {
      registered.push(registry.register(tool));
    }
  }
  return registered;
}

function loadSkills(registry, context, skillsDir = path.join(__dirname, "skills")) {
  const manifestFile = path.join(skillsDir, "_manifest.json");
  if (!fs.existsSync(manifestFile)) return [];
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const registered = [];

  for (const entry of (manifest.skills || []).filter((skill) => skill?.enabled !== false)) {
    const file = path.basename(String(entry.file || ""));
    if (!file || file !== entry.file || !file.endsWith(".js")) {
      throw new Error(`Invalid skill file: ${entry.file || entry.name || "unknown"}`);
    }
    const fullPath = path.join(skillsDir, file);
    delete require.cache[require.resolve(fullPath)];
    const mod = require(fullPath);
    if (typeof mod.execute !== "function") throw new Error(`Skill execute missing: ${entry.name || file}`);
    const skillManifest = mod.MANIFEST || {};
    const name = String(entry.name || skillManifest.name || "").trim();
    if (!name) throw new Error(`Skill name missing: ${file}`);
    const id = `skill_${name}`;
    registered.push(registry.register({
      id,
      name,
      description: entry.description || skillManifest.description || name,
      parameters: skillManifest.parameters || entry.parameters || { type: "object", properties: {}, required: [] },
      permission: { level: "skill.execute", scope: "skills" },
      async execute(params, toolContext) {
        return mod.execute(params, { ...context, ...toolContext, skill: entry });
      }
    }));
  }
  return registered;
}

module.exports = { loadTools, loadSkills };
