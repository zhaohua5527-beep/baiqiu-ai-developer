"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Worker, isMainThread, parentPort } = require("node:worker_threads");

if (!isMainThread) {
  parentPort.on("message", ({ id, file, value }) => {
    const temporaryFile = `${file}.pending-${process.pid}-${randomUUID()}`;
    let descriptor = null;
    try {
      const serialized = JSON.stringify(value);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      descriptor = fs.openSync(temporaryFile, "wx", 0o600);
      fs.writeFileSync(descriptor, serialized, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      parentPort.postMessage({ id, ok: true, file, temporaryFile, bytes: Buffer.byteLength(serialized) });
    } catch (error) {
      if (descriptor !== null) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporaryFile); } catch {}
      parentPort.postMessage({ id, ok: false, code: error.code, message: error.message });
    }
  });
} else {
  class BackgroundJsonSnapshot {
    constructor() {
      this.worker = null;
      this.pending = new Map();
    }

    stage(file, value) {
      if (!this.worker) {
        const worker = new Worker(__filename);
        this.worker = worker;
        worker.on("message", (result) => {
          const request = this.pending.get(result.id);
          if (!request) return;
          this.pending.delete(result.id);
          if (result.ok) request.resolve(result);
          else request.reject(Object.assign(new Error(result.message), { code: result.code }));
          if (!this.pending.size) worker.unref();
        });
        const fail = (error) => {
          if (this.worker !== worker) return;
          this.worker = null;
          for (const request of this.pending.values()) request.reject(error);
          this.pending.clear();
        };
        worker.on("error", fail);
        worker.on("exit", (code) => fail(new Error(`数据库工作线程已退出 (${code})`)));
      }
      const id = randomUUID();
      this.worker.ref();
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        try { this.worker.postMessage({ id, file: path.resolve(file), value }); }
        catch (error) {
          this.pending.delete(id);
          if (!this.pending.size) this.worker.unref();
          reject(error);
        }
      });
    }

    async close() {
      const worker = this.worker;
      this.worker = null;
      for (const request of this.pending.values()) request.reject(new Error("数据库工作线程已关闭"));
      this.pending.clear();
      await worker?.terminate();
    }
  }

  module.exports = { BackgroundJsonSnapshot };
}
