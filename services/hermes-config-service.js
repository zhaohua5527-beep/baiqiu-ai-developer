const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { resolveHermesHome } = require("./hermes-skill-service");

const PROVIDER_API_KEYS = Object.freeze({
  deepseek: ["DEEPSEEK_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  kimi: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
  qwen: ["DASHSCOPE_API_KEY"],
  zhipu: ["ZHIPU_API_KEY", "GLM_API_KEY"],
  minimax: ["MINIMAX_API_KEY", "MINIMAX_CN_API_KEY"],
  stepfun: ["STEPFUN_API_KEY"],
  xiaomi: ["XIAOMI_API_KEY"],
  hunyuan: ["TENCENT_TOKENHUB_API_KEY"]
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
  if (nativeRoute?.hosts.includes(endpointHost(endpoint))) {
    return {
      provider: nativeRoute.provider,
      apiMode: "",
      envKeys: PROVIDER_API_KEYS[providerId] || [],
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

function atomicTextWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, content, "utf8");
  fs.renameSync(temp, file);
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
      configFile: this.configFile
    };
  }

  apply({ provider, model, baseURL, apiKey = "", apiStyle = "openai" } = {}) {
    const providerId = String(provider || "").trim().toLowerCase();
    const modelId = String(model || "").trim();
    const endpoint = String(baseURL || "").trim();
    if (!providerId || !modelId || !endpoint) throw new Error("Hermes provider, model and base URL are required.");
    const mapping = resolveHermesProviderConfig({ provider: providerId, baseURL: endpoint, apiStyle });
    const config = structuredClone(this.read());
    config.model = { ...(config.model || {}), provider: mapping.provider, default: modelId, base_url: endpoint };
    if (mapping.apiMode) config.model.api_mode = mapping.apiMode;
    else delete config.model.api_mode;
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
    const currentConfig = fs.existsSync(this.configFile) ? fs.readFileSync(this.configFile, "utf8") : "";
    const nextConfig = YAML.stringify(config);
    let changed = false;
    if (currentConfig !== nextConfig) {
      atomicTextWrite(this.configFile, nextConfig);
      changed = true;
    }
    if (apiKey) {
      const current = fs.existsSync(this.envFile) ? fs.readFileSync(this.envFile, "utf8") : "";
      const next = mapping.envKeys.reduce((content, envKey) => updateEnvValue(content, envKey, apiKey), current);
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
  atomicTextWrite,
  customProviderName,
  endpointHost,
  resolveHermesProviderConfig,
  updateEnvValue
};
