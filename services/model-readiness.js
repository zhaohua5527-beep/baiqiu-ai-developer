"use strict";

const { normalizeProvider } = require("./model-adapter");
const { providerVerificationMatches } = require("./model-route-policy");

const MODEL_MANAGER_LINK = "baiqiu://open-model-manager";

function clean(value, limit = 500) {
  return String(value || "").trim().slice(0, limit);
}

function selectedModelReadiness(settings = {}) {
  const providerId = clean(settings.defaultProvider).toLowerCase();
  const provider = providerId && settings.providers?.[providerId];
  const normalized = provider ? normalizeProvider(providerId, provider) : null;
  const missing = [];

  if (!providerId || !provider) {
    missing.push("provider");
  } else {
    if (provider.enabled !== true) missing.push("enabled");
    if (!clean(normalized.model)) missing.push("model");
    if (!clean(normalized.baseURL)) missing.push("base_url");
    if (normalized.requiresApiKey !== false && !clean(normalized.apiKey, 10000)) missing.push("credential");
    if (!providerVerificationMatches(providerId, provider)) missing.push("verification");
  }

  return Object.freeze({
    configured: missing.length === 0,
    providerId,
    providerName: clean(normalized?.name || providerId),
    missing: Object.freeze(missing),
    action: Object.freeze({
      label: "前往模型管理",
      href: MODEL_MANAGER_LINK
    })
  });
}

function modelConfigurationRequiredText() {
  return [
    "尚未接入可用模型。请先在设置中完成模型配置，配置后重新发送这条消息。",
    "",
    `[前往模型管理](${MODEL_MANAGER_LINK})`
  ].join("\n");
}

module.exports = {
  MODEL_MANAGER_LINK,
  modelConfigurationRequiredText,
  selectedModelReadiness
};
