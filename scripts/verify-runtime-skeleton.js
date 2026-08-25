#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const node = process.execPath;

const steps = [
  ["--check", "resources/app/main.js"],
  ["--check", "resources/app/services/runtime/index.js"],
  ["--check", "resources/app/services/runtime/openclaw-runtime.js"],
  ["--check", "resources/app/services/runtime/hermes-runtime.js"],
  ["--check", "resources/app/services/runtime/hermes-client.js"],
  ["--check", "resources/app/services/runtime/runtime-factory.js"],
  ["--check", "resources/app/services/runtime/runtime-port.js"],
  ["--check", "resources/app/services/agent-services.js"],
  ["resources/app/tests/agent-runtime-skeleton-test.js"],
  ["resources/app/tests/default-relay-provider-test.js"]
];

let failed = false;
for (const args of steps) {
  const label = args.join(" ");
  process.stdout.write(`[run] node ${label}\n`);
  const result = spawnSync(node, args, {
    cwd: root,
    encoding: "utf8",
    env: process.env
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    process.stderr.write(`[fail] node ${label} (exit ${result.status})\n`);
    failed = true;
    break;
  }
  process.stdout.write(`[ok] node ${label}\n`);
}

if (failed) {
  process.exitCode = 1;
} else {
  process.stdout.write("ALL_OK\n");
}
