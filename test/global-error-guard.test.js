"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../renderer-v2/app.js"), "utf8");

test("layout notification warnings do not block chat while real exceptions remain visible", () => {
  const listeners = new Map();
  const overlays = [];
  vm.runInNewContext(source.slice(0, source.indexOf("const api = window.heiqiu")), {
    window: { addEventListener: (type, handler) => listeners.set(type, handler) },
    document: { createElement: () => ({}), body: { appendChild: node => overlays.push(node) } },
    console: { warn() {}, error() {} }
  });
  let suppressed = 0;
  for (const message of ["ResizeObserver loop completed with undelivered notifications.", "ResizeObserver loop limit exceeded"]) {
    listeners.get("error")({ message, error: null, preventDefault: () => suppressed++ });
    listeners.get("unhandledrejection")({ reason: new Error(message), preventDefault: () => suppressed++ });
  }
  assert.equal(suppressed, 4);
  assert.equal(overlays.length, 0);
  listeners.get("error")({ error: new TypeError("ResizeObserver is not a constructor") });
  assert.equal(overlays.length, 1);
  assert.match(overlays[0].innerHTML, /ResizeObserver is not a constructor/);
});
