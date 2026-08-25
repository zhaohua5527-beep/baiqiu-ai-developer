"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { resolveFolder } = require("../tools/folder-tools");

test("create_folder rejects absolute paths outside allowed roots", () => {
  assert.throws(() => resolveFolder({ path: "C:\\Windows\\System32", name: "x" }), /不在允许的工作区|PERMISSION_DENIED|路径不在/);
  assert.throws(() => resolveFolder({ path: "D:\\anything\\outside", name: "x" }), /不在允许的工作区|PERMISSION_DENIED|路径不在/);
});

test("create_folder allows paths inside workspace root", () => {
  const folder = resolveFolder({ path: "D:\\BaiQiuAI\\data\\workspace\\sub\\dir", name: "x" });
  assert.ok(folder.includes("BaiQiuAI"), "workspace paths should pass");
});

test("create_folder allows relative paths inside workspace", () => {
  const folder = resolveFolder({ path: "myfolder\\sub", name: "x" });
  assert.ok(folder.includes("myfolder"), "relative path should resolve into workspace");
});

test("create_folder allows desktop paths", () => {
  const folder = resolveFolder({ path: "desktop\\testfolder", name: "x" });
  assert.ok(folder.toLowerCase().includes("desktop"), "desktop path should resolve to user desktop");
});

test("create_folder rejects relative path traversal out of workspace", () => {
  assert.throws(() => resolveFolder({ path: "../../../outside", name: "x" }), /不在允许的工作区|PERMISSION_DENIED|路径不在/);
  assert.throws(() => resolveFolder({ path: "..\\..\\Windows", name: "x" }), /不在允许的工作区|PERMISSION_DENIED|路径不在/);
  assert.throws(() => resolveFolder({ path: "sub/../../escape", name: "x" }), /不在允许的工作区|PERMISSION_DENIED|路径不在/);
});

test("create_folder rejects desktop path traversal out of desktop", () => {
  assert.throws(() => resolveFolder({ path: "desktop\\..\\..\\Users\\Public", name: "x" }), /不在允许的工作区|PERMISSION_DENIED|路径不在/);
  assert.throws(() => resolveFolder({ path: "desktop/..\\..\\Windows", name: "x" }), /不在允许的工作区|PERMISSION_DENIED|路径不在/);
});
