const fs = require("node:fs");
const path = require("node:path");

async function exportKnowledgeAssets({ vault, zipFactory, exportRoot, now = new Date() }) {
  if (!vault || typeof vault.root !== "function" || typeof vault.files !== "function" || typeof vault.state !== "function") {
    throw new Error("Knowledge vault export requires a real KnowledgeVault instance.");
  }
  if (typeof zipFactory !== "function") throw new Error("Knowledge vault export requires a ZIP writer.");
  const knowledgeRoot = vault.root();
  const files = vault.files();
  const targetRoot = path.resolve(exportRoot || path.join(path.dirname(knowledgeRoot), "knowledge-exports"));
  fs.mkdirSync(targetRoot, { recursive: true });
  const stamp = now.toISOString().replace(/[T:.Z]/g, "").replace(/-/g, "");
  const outputPath = path.join(targetRoot, `knowledge-assets-${stamp}.zip`);
  const zip = zipFactory();
  for (const file of files) {
    const relative = path.relative(knowledgeRoot, file).replace(/\\/g, "/");
    zip.file(`knowledge/${relative}`, fs.readFileSync(file));
  }
  const state = vault.state();
  zip.file("knowledge-export-manifest.json", JSON.stringify({
    format: "baiqiu-knowledge-assets",
    version: 1,
    exportedAt: now.toISOString(),
    fileCount: files.length,
    totalKnowledgeUnits: state.totalKnowledgeUnits,
    totalBytes: state.totalBytes,
    categories: state.categories.map((item) => ({ id: item.id, count: item.count }))
  }, null, 2));
  fs.writeFileSync(outputPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  return {
    success: true,
    outputPath,
    fileCount: files.length,
    bytes: fs.statSync(outputPath).size
  };
}

module.exports = { exportKnowledgeAssets };
