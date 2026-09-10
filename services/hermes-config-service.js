const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { resolveHermesHome } = require("./hermes-skill-service");
const { RETRYABLE_RENAME_CODES } = require("./atomic-json-file");
const { normalizeProvider } = require("./model-adapter");

const PROVIDER_API_KEYS = Object.freeze({
  deepseek: ["DEEPSEEK_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  kimi: ["KIMI_API_KEY", "MOONSHOT_API_KEY", "KIMI_CN_API_KEY"],
  qwen: ["DASHSCOPE_API_KEY"],
  zhipu: ["ZHIPU_API_KEY", "GLM_API_KEY"],
  minimax: ["MINIMAX_API_KEY", "MINIMAX_CN_API_KEY"],
  stepfun: ["STEPFUN_API_KEY"],
  xiaomi: ["XIAOMI_API_KEY"],
  hunyuan: ["TENCENT_TOKENHUB_API_KEY", "TOKENHUB_API_KEY"]
});

const PROVIDER_BASE_URL_KEYS = Object.freeze({
  deepseek: "DEEPSEEK_BASE_URL", openai: "OPENAI_BASE_URL", anthropic: "ANTHROPIC_BASE_URL",
  qwen: "DASHSCOPE_BASE_URL", zhipu: "GLM_BASE_URL", minimax: "MINIMAX_CN_BASE_URL",
  stepfun: "STEPFUN_BASE_URL", xiaomi: "XIAOMI_BASE_URL", hunyuan: "TOKENHUB_BASE_URL"
});

const STT_PROVIDER_ENV_KEYS = Object.freeze({
  openai: "VOICE_TOOLS_OPENAI_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  xai: "XAI_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
  deepinfra: "DEEPINFRA_API_KEY"
});

const BAIQIU_CUSTOM_PROVIDER_NAMES = Object.freeze({
  openai: "baiqiu-openai",
  custom: "baiqiu-custom"
});

const HERMES_NATIVE_ROUTES = Object.freeze({
  deepseek: { provider: "deepseek", hosts: ["api.deepseek.com"] },
  openai: { provider: "openai-api", hosts: ["api.openai.com"] },
  anthropic: { provider: "anthropic", hosts: ["api.anthropic.com"] },
  kimi: { provider: "kimi-coding-cn", hosts: ["api.moonshot.cn"] },
  qwen: { provider: "alibaba", hosts: ["dashscope.aliyuncs.com"] },
  zhipu: { provider: "zai", hosts: ["open.bigmodel.cn"] },
  hunyuan: { provider: "tencent-tokenhub", hosts: ["tokenhub.tencentmaas.com"] },
  minimax: { provider: "minimax-cn", hosts: ["api.minimaxi.com"] },
  stepfun: { provider: "stepfun", hosts: ["api.stepfun.com"] },
  xiaomi: { provider: "xiaomi", hosts: ["api.xiaomimimo.com"] }
});

function endpointHost(baseURL = "") {
  try {
    return new URL(String(baseURL || "").trim()).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function customProviderName(providerId = "custom") {
  return BAIQIU_CUSTOM_PROVIDER_NAMES[providerId]
    || `baiqiu-${String(providerId || "custom").toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`;
}

function resolveHermesProviderConfig({ provider, baseURL, apiStyle = "openai" } = {}) {
  const providerId = String(provider || "").trim().toLowerCase();
  const endpoint = String(baseURL || "").trim();
  const style = String(apiStyle || "openai").trim().toLowerCase();
  const apiMode = style === "anthropic" ? "anthropic_messages" : "chat_completions";

  const nativeRoute = HERMES_NATIVE_ROUTES[providerId];
  const nativeStyle = providerId === "anthropic" ? "anthropic" : "openai";
  if (style === nativeStyle && nativeRoute?.hosts.includes(endpointHost(endpoint))) {
    return {
      provider: nativeRoute.provider,
      apiMode,
      envKeys: PROVIDER_API_KEYS[providerId] || [],
      baseURLEnvKey: PROVIDER_BASE_URL_KEYS[providerId] || "",
      customProviderName: ""
    };
  }

  const namedCustomProvider = customProviderName(providerId);
  const customKey = `BAIQIU_${providerId.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_API_KEY`;
  return {
    provider: `custom:${namedCustomProvider}`,
    apiMode,
    envKeys: [customKey],
    customProviderName: namedCustomProvider,
    customKey
  };
}

function sleepSync(ms) {
  if (!ms) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function atomicTextWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(temp, content, "utf8");
  let lastError = null;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_RENAME_CODES.has(String(error?.code || "")) || attempt === 6) break;
      sleepSync(8 * (2 ** (attempt - 1)));
    }
  }
  throw lastError || new Error(`Unable to replace ${file}`);
}

function updateEnvValue(content, key, value) {
  const lines = String(content || "").split(/\r?\n/);
  const prefix = `${key}=`;
  const next = `${prefix}${String(value || "").replace(/[\r\n]/g, "")}`;
  const index = lines.findIndex((line) => line.trimStart().startsWith(prefix));
  if (index >= 0) lines[index] = next;
  else lines.push(next);
  return `${lines.filter((line, lineIndex) => line || lineIndex < lines.length - 1).join("\n").trimEnd()}\n`;
}

function normalizeSttConfig(input = {}) {
  const provider = String(input.provider || "local").trim().toLowerCase();
  const supported = new Set(["local", "local_command", "openai", "groq", "mistral", "xai", "elevenlabs", "deepinfra", "none"]);
  return {
    enabled: input.enabled !== false,
    provider: supported.has(provider) ? provider : "local",
    model: String(input.model || "").trim(),
    baseURL: String(input.baseURL || "").trim(),
    language: String(input.language || "").trim().slice(0, 16),
    apiKey: String(input.apiKey || "").trim()
  };
}

function normalizeHermesReasoningEffort(value = "") {
  return ({
    off: "none",
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    extra_high: "xhigh",
    maximum: "xhigh"
  })[String(value || "").trim().toLowerCase()] || "";
}

function resolveHermesProtocol({ provider, model, baseURL, apiStyle = "openai", reasoning = "maximum" } = {}) {
  const mapping = resolveHermesProviderConfig({ provider, baseURL, apiStyle });
  if (mapping.provider !== "zai" || !/^glm-5\.3(?:-flash)?$/i.test(String(model || ""))) return null;
  return {
    id: "glm-preserved-thinking",
    provider: mapping.provider,
    model: String(model).toLowerCase(),
    baseURL: String(baseURL).replace(/\/+$/, ""),
    reasoningEffort: reasoning === "maximum" ? "max" : "",
    extraBody: { thinking: { type: "enabled", clear_thinking: false }, tool_stream: true }
  };
}

class HermesConfigService {
  constructor(options = {}) {
    this.home = resolveHermesHome(options);
    this.configFile = path.join(this.home, "config.yaml");
    this.envFile = path.join(this.home, ".env");
    this.cache = null;
    this.cacheMtime = -1;
  }

  read() {
    const stat = fs.existsSync(this.configFile) ? fs.statSync(this.configFile) : null;
    if (this.cache && stat?.mtimeMs === this.cacheMtime) return this.cache;
    const parsed = stat ? YAML.parse(fs.readFileSync(this.configFile, "utf8")) : {};
    this.cache = parsed && typeof parsed === "object" ? parsed : {};
    this.cacheMtime = stat?.mtimeMs ?? -1;
    return this.cache;
  }

  runtime() {
    const config = this.read();
    return {
      runtime: "hermes",
      provider: String(config.model?.provider || "").trim(),
      model: String(config.model?.default || "").trim(),
      baseURL: String(config.model?.base_url || "").trim(),
      reasoningEffort: String(config.agent?.reasoning_effort || "").trim(),
      providerProtocol: config.baiqiu?.provider_protocol || null,
      configFile: this.configFile
    };
  }

  apply({ provider, model, baseURL, apiKey = "", apiStyle = "openai", reasoning = "", nativeReasoning = false, stt = {} } = {}) {
    const providerId = String(provider || "").trim().toLowerCase();
    const modelId = String(model || "").trim();
    const rawEndpoint = String(baseURL || "").trim();
    const endpoint = rawEndpoint
      ? normalizeProvider(providerId, { baseURL: rawEndpoint }).baseURL
      : "";
    if (!providerId || !modelId || !endpoint) throw new Error("Hermes provider, model and base URL are required.");
    const mapping = resolveHermesProviderConfig({ provider: providerId, baseURL: endpoint, apiStyle });
    const protocol = resolveHermesProtocol({ provider: providerId, model: modelId, baseURL: endpoint, apiStyle, reasoning });
    const config = structuredClone(this.read());
    config.model = { ...(config.model || {}), provider: mapping.provider, default: modelId, base_url: endpoint };
    if (mapping.apiMode) config.model.api_mode = mapping.apiMode;
    else delete config.model.api_mode;
    config.agent = { ...(config.agent || {}) };
    config.baiqiu = { ...(config.baiqiu || {}), provider_protocol: protocol };
    const reasoningEffort = nativeReasoning && !protocol ? normalizeHermesReasoningEffort(reasoning) : "";
    if (reasoningEffort) config.agent.reasoning_effort = reasoningEffort;
    else delete config.agent.reasoning_effort;
    if (mapping.customProviderName) {
      const providers = Array.isArray(config.custom_providers) ? config.custom_providers : [];
      const entry = {
        name: mapping.customProviderName,
        base_url: endpoint,
        key_env: mapping.customKey,
        api_mode: mapping.apiMode
      };
      const index = providers.findIndex((item) => item?.name === mapping.customProviderName);
      if (index >= 0) providers[index] = { ...providers[index], ...entry };
      else providers.push(entry);
      config.custom_providers = providers;
    }
    config.delegation = {
      ...(config.delegation || {}),
      provider: mapping.provider,
      model: modelId,
      base_url: endpoint,
      child_timeout_seconds: 300,
      subagent_auto_approve: true
    };
    const sttConfig = normalizeSttConfig(stt);
    config.stt = {
      ...(config.stt || {}),
      enabled: sttConfig.enabled,
      provider: sttConfig.provider
    };
    if (sttConfig.language) config.stt.language = sttConfig.language;
    else delete config.stt.language;
    if (sttConfig.provider !== "none") {
      const sectionName = sttConfig.provider;
      config.stt[sectionName] = {
        ...(config.stt[sectionName] || {})
      };
      if (sectionName === "local" && process.platform === "win32") {
        config.stt[sectionName].device = "cpu";
        config.stt[sectionName].compute_type = "int8";
      }
      if (sttConfig.model) config.stt[sectionName].model = sttConfig.model;
      else delete config.stt[sectionName].model;
      if (sttConfig.baseURL) config.stt[sectionName].base_url = sttConfig.baseURL;
      else delete config.stt[sectionName].base_url;
    }
    const currentConfig = fs.existsSync(this.configFile) ? fs.readFileSync(this.configFile, "utf8") : "";
    const nextConfig = YAML.stringify(config);
    let changed = false;
    if (currentConfig !== nextConfig) {
      atomicTextWrite(this.configFile, nextConfig);
      changed = true;
    }
    if (apiKey || mapping.baseURLEnvKey) {
      const current = fs.existsSync(this.envFile) ? fs.readFileSync(this.envFile, "utf8") : "";
      let next = apiKey ? mapping.envKeys.reduce((content, envKey) => updateEnvValue(content, envKey, apiKey), current) : current;
      if (mapping.baseURLEnvKey) next = updateEnvValue(next, mapping.baseURLEnvKey, endpoint);
      if (current !== next) {
        atomicTextWrite(this.envFile, next);
        changed = true;
      }
    }
    const sttEnvKey = STT_PROVIDER_ENV_KEYS[sttConfig.provider];
    if (sttEnvKey && sttConfig.apiKey) {
      const current = fs.existsSync(this.envFile) ? fs.readFileSync(this.envFile, "utf8") : "";
      const next = updateEnvValue(current, sttEnvKey, sttConfig.apiKey);
      if (current !== next) {
        atomicTextWrite(this.envFile, next);
        changed = true;
      }
    }
    this.cache = null;
    this.cacheMtime = -1;
    return { ...this.runtime(), changed };
  }
}

module.exports = {
  BAIQIU_CUSTOM_PROVIDER_NAMES,
  HERMES_NATIVE_ROUTES,
  HermesConfigService,
  PROVIDER_API_KEYS,
  PROVIDER_BASE_URL_KEYS,
  STT_PROVIDER_ENV_KEYS,
  atomicTextWrite,
  customProviderName,
  endpointHost,
  resolveHermesProviderConfig,
  normalizeSttConfig,
  normalizeHermesReasoningEffort,
  resolveHermesProtocol,
  updateEnvValue
};
