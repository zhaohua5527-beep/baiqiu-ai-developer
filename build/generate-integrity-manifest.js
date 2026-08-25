"use strict";

const path = require("node:path");

const IntegrityChecker = require("../services/integrity-checker");

function generateIntegrityManifest(rootDir = path.resolve(__dirname, "..")) {
  const checker = new IntegrityChecker({ rootDir: path.resolve(rootDir) });
  const manifest = checker.createManifest();
  const verification = checker.verify();
  if (!verification.ok) {
    throw new Error(`Generated integrity manifest failed verification: ${JSON.stringify(verification.issues)}`);
  }
  return {
    manifestPath: checker.manifestPath,
    files: Object.keys(manifest.files || {})
  };
}

if (require.main === module) {
  const result = generateIntegrityManifest();
  process.stdout.write(`Integrity manifest refreshed: ${result.manifestPath} (${result.files.length} files)\n`);
}

module.exports = { generateIntegrityManifest };
