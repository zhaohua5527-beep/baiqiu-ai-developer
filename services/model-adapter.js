const PRESET_PROVIDERS = {
  deepseek: { name: "DeepSeek", baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat", apiStyle: "openai", requiresApiKey: true, apiKeyUrl: "https://platform.deepseek.com/" },
  openai: { name: "GPT", baseURL: "https://api.openai.com/v1", model: "gpt-4.1", apiStyle: "openai", requiresApiKey: true, apiKeyUrl: "https://platform.openai.com/api-keys" },
  kimi: { name: "Kimi", baseURL: "https://api.moonshot.cn/v1", model: "kimi-k3", apiStyle: "openai", requiresApiKey: true, apiKeyUrl: "https://platform.moonshot.cn/console/api-keys" },
  anthropic: { name: "Claude", baseURL: "https://api.anthropic.com/v1", model: "claude-3-5-sonnet-latest", apiStyle: "anthropic", requiresApiKey: true, apiKeyUrl: "https://console.anthropic.com/" },
  qwen: { name: "通义千问", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.7-plus", apiStyle: "openai", requiresApiKey: true, apiKeyUrl: "https://help.aliyun.com/zh/model-studio/get-api-key" },
  baidu: { name: "文心大模型", baseURL: "https://qianfan.baidubce.com/v2", model: "ernie-4.5-turbo-128k", apiStyle: "openai", requiresApiKey: true, apiKeyUrl: "https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application" },
  zhipu: { name: "智谱 GLM", baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.2", apiStyle: "openai", requiresApiKey: true, apiKeyUrl: "https://open.bigmodel.cn/usercenter/apikeys" },
  doubao: { name: "豆包", baseURL: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seed-1-8-251228", apiStyle: "openai", requiresApiKey: true, apiKeyUrl: "https://www.volcengine.com/docs/82379/1361424" },
  hunyuan: { name: "腾讯混元", baseURL: "https://tokenhub.tencentmaas.com/v1", model: "hy3", apiStyle: "openai", requiresApiKey: true, apiKeyUrl: "https://www.tencentcloud.com/zh/document/product/1300/78949" },
  minimax: { name: "MiniMax", baseURL: "https://api.minimaxi.com/anthropic/v1", model: "MiniMax-M3", apiStyle: "anthropic", requiresApiKey: true, apiKeyUrl: "https://platform.minimaxi.com/docs/guides/quickstart-preparation" },
  stepfun: { name: "阶跃星辰", baseURL: "https://api.stepfun.com/v1", model: "step-3.7-flash", apiStyle: "openai", requiresApiKey: true, apiKeyUrl: "https://platform.stepfun.com/docs/zh/welcome" },
  xiaomi: { name: "Xiaomi MiMo", baseURL: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-pro", apiStyle: "openai", requiresApiKey: true, apiKeyUrl: "https://platform.xiaomimimo.com/" },
  ollama: { name: "Ollama 本地", baseURL: "http://localhost:11434/v1", model: "qwen2.5:7b", apiStyle: "openai", requiresApiKey: false, local: true, apiKeyUrl: "https://ollama.com/" }
};

const MODEL_PROBE_TOKEN = "BAIQIU_MODEL_OK";

function normalizeProvider(id, provider = {}) {
  const preset = PRESET_PROVIDERS[id] || {};
  const baseURL = String(provider.baseURL || preset.baseURL || "")
    .trim()
    .replace(/\/(?:chat\/completions|responses|models)\/?$/i, "")
    .replace(/\/+$/, "");
  return {
    id,
    ...preset,
    ...provider,
    name: provider.name || preset.name || id,
    baseURL,
    model: provider.model || preset.model || "",
    apiStyle: preset.apiStyle || provider.apiStyle || "openai",
    requiresApiKey: provider.requiresApiKey !== undefined ? Boolean(provider.requiresApiKey) : preset.requiresApiKey !== false,
    local: Boolean(provider.local || preset.local),
    apiKeyUrl: String(provider.apiKeyUrl || preset.apiKeyUrl || "").trim()
  };
}

function providerHeaders(normalized) {
  const headers = { Accept: "application/json" };
  if (normalized.apiStyle === "anthropic") {
    if (normalized.apiKey) headers["x-api-key"] = normalized.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (normalized.apiKey) {
    headers.Authorization = `Bearer ${normalized.apiKey}`;
  }
  return headers;
}

async function listProviderModels({ providerId, provider, fetchImpl = fetch, signal = null }) {
  const normalized = normalizeProvider(providerId, provider);
  if (!normalized.baseURL) throw new Error(`模型 ${normalized.name} 缺少 Base URL`);
  if (normalized.requiresApiKey && !normalized.apiKey) throw new Error(`请先填写 ${normalized.name} 的 API Key。`);
  const response = await fetchImpl(`${normalized.baseURL}/models`, {
    method: "GET",
    headers: providerHeaders(normalized),
    signal: signal || undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || payload.message || `读取模型列表失败（HTTP ${response.status}）`);
  const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
  const models = rows
    .map((item) => typeof item === "string" ? item : item?.id)
    .filter((id) => typeof id === "string" && id.trim())
    .map((id) => id.trim())
    .filter((id, index, all) => all.indexOf(id) === index)
    .sort((a, b) => a.localeCompare(b));
  if (!models.length) throw new Error("供应商没有返回可用模型 ID。请检查 Base URL 是否为 API 地址。");
  return { providerId, providerName: normalized.name, baseURL: normalized.baseURL, models };
}

async function callChatCompletion({ providerId, provider, body, fetchImpl = fetch, signal = null }) {
  const normalized = normalizeProvider(providerId, provider);
  if (!normalized.baseURL) throw new Error(`模型 ${normalized.name} 缺少 Base URL`);
  if (normalized.requiresApiKey && !normalized.apiKey) throw new Error(`请先在设置中填写 ${normalized.name} 的 API Key。`);
  if (!["openai", "anthropic"].includes(normalized.apiStyle)) throw new Error(`不支持的模型协议：${normalized.apiStyle}`);

  const url = `${normalized.baseURL}/${normalized.apiStyle === "anthropic" ? "messages" : "chat/completions"}`;
  const headers = { "Content-Type": "application/json", ...providerHeaders(normalized) };
  const startedAt = Date.now();
  const requestModel = body.model || normalized.model;
  const requestBody = normalized.apiStyle === "anthropic"
    ? {
        model: requestModel,
        max_tokens: body.max_tokens || 4096,
        system: body.messages?.find((item) => item.role === "system")?.content || "",
        messages: (body.messages || [])
          .filter((item) => item.role !== "system")
          .map((item) => ({ role: item.role === "assistant" ? "assistant" : "user", content: item.content })),
        ...(body.tools?.length ? {
          tools: body.tools.map((tool) => ({
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters
          }))
        } : {})
      }
    : { ...body, model: requestModel };
  console.log(`[ModelAdapter] ${normalized.local ? "本地" : "云端"}模型调用: provider=${normalized.name}, baseURL=${normalized.baseURL}, model=${requestModel}`);
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
    signal: signal || undefined
  });
  const payload = await response.json().catch(() => ({}));
  payload._debug = {
    providerId,
    providerName: normalized.name,
    model: requestModel,
    baseURL: normalized.baseURL,
    url,
    local: Boolean(normalized.local),
    status: response.status,
    ok: response.ok,
    durationMs: Date.now() - startedAt,
    usage: payload.usage || null,
    sentAt: startedAt,
    receivedAt: Date.now()
  };
  if (!response.ok) throw new Error(payload.error?.message || payload.message || `HTTP ${response.status}`);
  if (normalized.apiStyle === "anthropic" && Array.isArray(payload.content)) {
    const text = payload.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    const toolCalls = payload.content.filter((item) => item.type === "tool_use").map((item) => ({
      id: item.id,
      type: "function",
      function: { name: item.name, arguments: JSON.stringify(item.input || {}) }
    }));
    payload.choices = [{ message: { role: "assistant", content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }];
  }
  const hasOpenAiChoice = Array.isArray(payload.choices) && payload.choices.length > 0;
  const hasResponsesText = typeof payload.output_text === "string" && payload.output_text.length > 0;
  if (!hasOpenAiChoice && !hasResponsesText) {
    const error = new Error("模型接口已返回，但响应中没有可用的回复内容。请检查 Base URL 是否为 OpenAI 兼容 chat/completions 地址。");
    error.debug = payload._debug;
    throw error;
  }
  return payload;
}

function completionText(payload = {}) {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n")
      .trim();
  }
  return typeof payload.output_text === "string" ? payload.output_text.trim() : "";
}

async function probeProvider({ providerId, provider, fetchImpl = fetch, signal = null }) {
  const normalized = normalizeProvider(providerId, provider);
  const payload = await callChatCompletion({
    providerId,
    provider: normalized,
    body: {
      model: normalized.model,
      messages: [
        { role: "system", content: "You are a connection verifier. Follow the user's output format exactly." },
        { role: "user", content: `只回复 ${MODEL_PROBE_TOKEN}，不要添加其他内容。` }
      ],
      max_tokens: 32,
      stream: false
    },
    fetchImpl,
    signal
  });
  const text = completionText(payload);
  if (!text.includes(MODEL_PROBE_TOKEN)) {
    throw new Error(`模型接口已响应，但没有返回校验词 ${MODEL_PROBE_TOKEN}。`);
  }
  return {
    providerId,
    providerName: normalized.name,
    model: normalized.model,
    baseURL: normalized.baseURL,
    verified: true,
    verifiedAt: new Date().toISOString(),
    latencyMs: payload._debug?.durationMs ?? null,
    statusCode: payload._debug?.status ?? null
  };
}

async function verifyProviderConnection({ providerId, provider, fetchImpl = fetch, signal = null }) {
  let models = [];
  let modelListWarning = "";
  try {
    const listed = await listProviderModels({ providerId, provider, fetchImpl, signal });
    models = listed.models;
  } catch (error) {
    modelListWarning = error?.message || String(error);
  }
  const probe = await probeProvider({ providerId, provider, fetchImpl, signal });
  return { ...probe, models, modelListWarning };
}

module.exports = {
  MODEL_PROBE_TOKEN,
  PRESET_PROVIDERS,
  callChatCompletion,
  completionText,
  listProviderModels,
  normalizeProvider,
  probeProvider,
  verifyProviderConnection
};
