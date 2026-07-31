"use strict";

const { normalizeProvider } = require("./model-adapter");

const LOCAL_PROVIDER_IDS = new Set(["ollama", "local"]);

function clean(value = "") {
  return String(value || "").trim();
}

function isLoopbackUrl(value = "") {
  try {
    const hostname = new URL(clean(value)).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return /(?:^|\/\/)(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::|\/|$)/i.test(clean(value));
  }
}

function isLocalProvider(providerId = "", provider = {}) {
  const id = clean(providerId).toLowerCase();
  const normalized = normalizeProvider(id, provider || {});
  return LOCAL_PROVIDER_IDS.has(id)
    || normalized.local === true
    || isLoopbackUrl(normalized.baseURL);
}

function isConfiguredProvider(providerId = "", provider = {}) {
  const normalized = normalizeProvider(providerId, provider || {});
  if (!normalized.baseURL) return false;
  if (normalized.requiresApiKey && !clean(normalized.apiKey)) return false;
  return Boolean(clean(normalized.model));
}

function candidateProviders(settings = {}) {
  const providers = settings.providers || {};
  const preferred = clean(settings.defaultProvider || "deepseek");
  return Object.entries(providers)
    .map(([id, provider]) => ({ id, provider: provider || {} }))
    .sort((a, b) => {
      if (a.id === preferred) return -1;
      if (b.id === preferred) return 1;
      if (a.provider.enabled === true && b.provider.enabled !== true) return -1;
      if (b.provider.enabled === true && a.provider.enabled !== true) return 1;
      return a.id.localeCompare(b.id);
    });
}

function modelPolicyError(message, details = {}) {
  const error = new Error(message);
  error.code = "MODEL_POLICY_REMOTE_PROVIDER_REQUIRED";
  error.details = details;
  return error;
}

function selectModelRoute(settings = {}, constraints = {}) {
  const preferred = clean(settings.defaultProvider || "deepseek");
  const entries = candidateProviders(settings);
  const current = entries.find((item) => item.id === preferred);
  const disallowLocal = constraints.disallowLocalModel === true;
  const allowLocalFallback = constraints.allowLocalFallback !== false;

  if (!current) {
    throw modelPolicyError("当前模型配置不存在，无法安全选择模型。", { preferred, disallowLocal, allowLocalFallback });
  }

  const currentLocal = isLocalProvider(current.id, current.provider);
  if ((!disallowLocal || !currentLocal) && isConfiguredProvider(current.id, current.provider)) {
    const normalized = normalizeProvider(current.id, current.provider);
    return Object.freeze({
      providerId: current.id,
      model: normalized.model || "",
      local: currentLocal,
      fallback: false,
      fallbackReason: "",
      constraints: Object.freeze({ disallowLocalModel: disallowLocal, allowLocalFallback })
    });
  }

  const remote = entries.find((item) => !isLocalProvider(item.id, item.provider) && isConfiguredProvider(item.id, item.provider));
  if (remote) {
    const normalized = normalizeProvider(remote.id, remote.provider);
    return Object.freeze({
      providerId: remote.id,
      model: normalized.model || "",
      local: false,
      fallback: remote.id !== preferred,
      fallbackReason: currentLocal ? "local_model_disallowed" : "preferred_provider_unavailable",
      constraints: Object.freeze({ disallowLocalModel: disallowLocal, allowLocalFallback })
    });
  }

  if (disallowLocal || !allowLocalFallback) {
    throw modelPolicyError("用户已禁止本地模型，但当前没有配置可用的远程模型。", {
      preferred,
      disallowLocal,
      allowLocalFallback,
      configuredProviders: entries.filter((item) => isConfiguredProvider(item.id, item.provider)).map((item) => item.id)
    });
  }

  if (isConfiguredProvider(current.id, current.provider)) {
    const normalized = normalizeProvider(current.id, current.provider);
    return Object.freeze({
      providerId: current.id,
      model: normalized.model || "",
      local: currentLocal,
      fallback: false,
      fallbackReason: "",
      constraints: Object.freeze({ disallowLocalModel: false, allowLocalFallback: true })
    });
  }

  throw modelPolicyError("当前没有配置可用模型。", { preferred, disallowLocal, allowLocalFallback });
}

function settingsForModelRoute(settings = {}, constraints = {}) {
  const route = selectModelRoute(settings, constraints);
  return Object.freeze({
    settings: route.providerId === settings.defaultProvider
      ? settings
      : { ...settings, defaultProvider: route.providerId },
    route
  });
}

module.exports = {
  LOCAL_PROVIDER_IDS,
  isLoopbackUrl,
  isLocalProvider,
  isConfiguredProvider,
  candidateProviders,
  selectModelRoute,
  settingsForModelRoute
};
