"use strict";

const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { writeJsonAtomic } = require("./atomic-json-file");
const MODEL_SETTINGS_FIELDS = ["providers", "defaultProvider", "reasoning", "modelRuntime", "modelConfigRevision", "modelConfigGeneration"];

function copyModelSettings(source, target) {
  for (const field of MODEL_SETTINGS_FIELDS) {
    if (Object.hasOwn(source, field)) target[field] = structuredClone(source[field]);
    else delete target[field];
  }
  return target;
}

function assertModelSettingsRevision(settings, expectedRevision) {
  if (expectedRevision !== undefined && String(expectedRevision || "") !== String(settings.modelConfigRevision || "")) {
    const error = new Error("模型配置已更新，本次旧操作未写入。请重新打开模型配置后再修改。");
    error.code = "MODEL_SETTINGS_CONFLICT";
    throw error;
  }
}

class ModelSettingsStore {
  constructor(file, { write = writeJsonAtomic } = {}) {
    this.file = file;
    this.write = write;
    this.loaded = false;
    this.record = null;
    this.pending = Promise.resolve();
  }

  read() {
    if (this.loaded) return this.record;
    try {
      const record = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (record.version !== 1 || !record.settings?.providers || typeof record.settings.modelConfigRevision !== "string") {
        throw new Error("模型配置记录无效，原文件已保留，请检查配置存储。");
      }
      this.record = record;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    this.loaded = true;
    return this.record;
  }

  apply(settings) {
    const record = this.read();
    return record ? copyModelSettings(record.settings, settings) : settings;
  }

  commit(settings, expectedRevision = settings.modelConfigRevision || "") {
    const submitted = copyModelSettings(settings, {});
    const operation = this.pending.catch(() => null).then(async () => {
      assertModelSettingsRevision(this.read()?.settings || {}, expectedRevision);
      submitted.modelConfigGeneration = Number(this.read()?.settings.modelConfigGeneration || 0) + 1;
      submitted.modelConfigRevision = randomUUID();
      const record = { version: 1, settings: submitted };
      await this.write(this.file, record);
      this.record = record;
      this.loaded = true;
      return copyModelSettings(submitted, {});
    });
    this.pending = operation;
    return operation;
  }

  cacheCatalog(settings, providerId, expectedProvider, metadata) {
    const fallback = copyModelSettings(settings, {});
    const operation = this.pending.catch(() => null).then(async () => {
      const latest = copyModelSettings(this.read()?.settings || fallback, {});
      const provider = latest.providers?.[providerId];
      if (!provider || ["apiKey", "baseURL", "apiStyle"].some(field => String(provider[field] || "") !== String(expectedProvider[field] || ""))) return false;
      Object.assign(provider, metadata);
      latest.modelConfigRevision ||= "";
      const record = { version: 1, settings: latest };
      await this.write(this.file, record);
      this.record = record;
      this.loaded = true;
      return true;
    });
    this.pending = operation;
    return operation;
  }
}

module.exports = { ModelSettingsStore, copyModelSettings, assertModelSettingsRevision };
