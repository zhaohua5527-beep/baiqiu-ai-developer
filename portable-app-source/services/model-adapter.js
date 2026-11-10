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
const FIRST_STREAM_DELTA_TIMEOUT_MS = 30_000;
const PROMPT_REASONING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "extra_high", "maximum"]);

const NON_CONVERSATIONAL_MODEL_PATTERN = /(?:^|[-_.])(?:asr|tts|stt|embedding|embeddings|rerank|image|video|audio|speech|voiceclone|voicedesign|transcribe)(?:$|[-_.])/i;

function providerHttpError(response, payload = {}, context = {}) {
  const status = Number(response?.status || 0);
  const message = payload?.error?.message || payload?.message || `HTTP ${status || "unknown"}`;
  const providerCode = String(payload?.error?.code || payload?.code || "");
  let publicMessage = String(message);
  if (/does not have a valid CodingPlan subscription|subscription has expired/i.test(publicMessage)) {
    publicMessage = "火山方舟返回：当前账号没有有效的 Coding Plan 订阅或订阅已过期。请核对套餐状态与 Base URL；不会自动切换到按量计费接口。";
  } else if (/has not activated the model/i.test(publicMessage)) {
    publicMessage = `火山方舟返回：当前账号尚未开通模型 ${context.model || ""}，请在方舟控制台开通对应模型服务后重试。`;
  } else if (/model or endpoint .* does not exist or you do not have access/i.test(publicMessage)) {
    publicMessage = `供应商返回：模型或接入点 ${context.model || ""} 不存在，或当前密钥没有访问权限。请核对模型 ID / 接入点 ID、开通状态及 Base URL。`;
  } else if (status === 401) {
    publicMessage = `供应商拒绝了身份验证（HTTP 401）。请核对 API Key 是否有效，以及它是否属于当前接口地址。原始原因：${message}`;
  } else if (status === 405) {
    publicMessage = `接口不接受当前请求方法（HTTP 405）。请核对 Base URL 是否为 API 地址，以及 Chat / Messages 协议是否匹配。原始原因：${message}`;
  }
  const error = new Error(publicMessage);
  error.code = status ? `PROVIDER_HTTP_${status}` : "PROVIDER_HTTP_ERROR";
  error.status = status || null;
  error.statusCode = status || null;
  error.providerCode = providerCode;
  error.providerMessage = String(message);
  error.providerId = String(context.providerId || "");
  error.providerName = String(context.providerName || context.providerId || "");
  error.model = String(context.model || "");
  error.debug = context.debug || null;
  return error;
}

function isConversationModelId(modelId = "") {
  const value = String(modelId || "").trim();
  return Boolean(value) && !NON_CONVERSATIONAL_MODEL_PATTERN.test(value);
}

function conversationModelIds(models = []) {
  return [...new Set((Array.isArray(models) ? models : [])
    .map((model) => String(model || "").trim())
    .filter(isConversationModelId))];
}

function inferredModelCapabilities(modelId = "", provider = {}) {
  const model = String(modelId || "").trim();
  const apiStyle = String(provider.apiStyle || "openai").toLowerCase();
  if (apiStyle === "openai" && /^(?:gpt-5(?:[.\-]|$)|o1(?:[.\-]|$)|o3(?:[.\-]|$)|o4(?:[.\-]|$))/i.test(model)) {
    const levels = /^gpt-5/i.test(model)
      ? ["minimal", "low", "medium", "high", "extra_high"]
      : ["low", "medium", "high"];
    return {
      model,
      reasoningMode: "native-candidate",
      reasoningLevels: levels,
      reasoningTransport: "reasoning_effort",
      reasoningVerified: false
    };
  }
  if (/deepseek-(?:reasoner|r1)/i.test(model)) {
    return {
      model,
      reasoningMode: "native-fixed",
      reasoningLevels: ["maximum"],
      reasoningTransport: "model-selection",
      reasoningVerified: true
    };
  }
  return {
    model,
    reasoningMode: "prompt",
    reasoningLevels: [...PROMPT_REASONING_LEVELS],
    reasoningTransport: "system-prompt",
    reasoningVerified: false
  };
}

function mapModelCapabilities(models = [], provider = {}) {
  return Object.fromEntries(conversationModelIds(models).map((model) => [model, inferredModelCapabilities(model, provider)]));
}

function normalizeProvider(id, provider = {}) {
  const preset = PRESET_PROVIDERS[id] || {};
  const apiStyle = String(provider.apiStyle || preset.apiStyle || "openai").trim().toLowerCase();
  let baseURL = String(provider.baseURL || preset.baseURL || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(?:chat\/completions|responses|messages|models)$/i, "")
    .replace(/\/+$/, "");
  if (apiStyle === "anthropic" && baseURL && !/\/v1$/i.test(baseURL)) baseURL += "/v1";
  return {
    id,
    ...preset,
    ...provider,
    name: provider.name || preset.name || id,
    baseURL,
    model: String(provider.model || preset.model || "").trim(),
    apiStyle,
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

function normalizeOpenAICompatibleMessages(messages = []) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (!message || typeof message !== "object") return message;
    const role = String(message.role || "").trim().toLowerCase();
    if (role !== "developer") return message;
    return { ...message, role: "system" };
  });
}

function deepSeekModelMetadataFromHtml(html, models = []) {
  const { load } = require("cheerio");
  const document = load(html);
  const metadata = {};
  document("table").each((_index, table) => {
    const rows = document(table).find("tr").map((_rowIndex, row) => [document(row).children("td,th").map((_cellIndex, cell) => {
      const content = document(cell).clone();
      content.find("sup").remove();
      return content.text().trim();
    }).get()]).get();
    const ids = rows.find(row => row[0] === "模型")?.slice(1) || [];
    const versions = rows.find(row => row[0] === "模型版本")?.slice(1) || [];
    if (ids.length !== versions.length) return;
    ids.forEach((id, index) => {
      if (models.includes(id) && versions[index] && versions[index].length <= 160) {
        metadata[id] = { displayName: versions[index], source: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing" };
      }
    });
  });
  return metadata;
}

async function listProviderModels({ providerId, provider, fetchImpl = fetch, signal = null, includeMetadata = false }) {
  const normalized = normalizeProvider(providerId, provider);
  if (!normalized.baseURL) throw new Error(`模型 ${normalized.name} 缺少 Base URL`);
  if (normalized.requiresApiKey && !normalized.apiKey) throw new Error(`请先填写 ${normalized.name} 的 API Key。`);
  const rows = [];
  const cursors = new Set();
  let cursor = "";
  do {
    const url = new URL(`${normalized.baseURL}/models`);
    if (cursor) url.searchParams.set("after_id", cursor);
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: providerHeaders(normalized),
      signal: signal || undefined
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw providerHttpError(response, payload, {
        providerId,
        providerName: normalized.name,
        debug: { providerId, providerName: normalized.name, status: response.status, ok: false }
      });
    }
    rows.push(...(Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : []));
    cursor = payload.has_more === true ? String(payload.last_id || "") : "";
    if (payload.has_more === true && (!cursor || cursors.has(cursor) || cursors.size >= 100)) {
      throw new Error("模型目录分页未完成，请稍后重新获取。");
    }
    if (cursor) cursors.add(cursor);
  } while (cursor);
  const allModels = rows
    .map((item) => typeof item === "string" ? item : item?.id)
    .filter((id) => typeof id === "string" && id.trim())
    .map((id) => id.trim())
    .filter((id, index, all) => all.indexOf(id) === index)
    .sort((a, b) => a.localeCompare(b));
  if (!allModels.length) throw new Error("供应商没有返回可用模型 ID。请检查 Base URL 是否为 API 地址。");
  const models = conversationModelIds(allModels);
  if (!models.length) throw new Error("供应商返回的型号不包含可用于黑球对话的文本模型。");
  const catalogSource = `${normalized.baseURL}/models`;
  const modelMetadata = Object.fromEntries(rows.filter(item => item && typeof item === "object" && models.includes(item.id))
    .map(item => [item.id, { displayName: String(item.display_name || item.name || item.id).trim().slice(0, 160), source: catalogSource }]));
  let metadataWarning = "";
  if (includeMetadata && new URL(normalized.baseURL).origin === "https://api.deepseek.com") {
    try {
      const timeout = AbortSignal.timeout(4000);
      const response = await fetchImpl("https://api-docs.deepseek.com/zh-cn/quick_start/pricing", {
        headers: { Accept: "text/html" }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      });
      if (!response.ok) throw new Error("official model details unavailable");
      const official = deepSeekModelMetadataFromHtml(await response.text(), models);
      if (!Object.keys(official).length) throw new Error("official model details changed");
      Object.assign(modelMetadata, official);
    } catch {
      metadataWarning = "目录已更新，官方版本名称暂未获取；当前显示真实 API ID。";
    }
  }
  return {
    providerId,
    providerName: normalized.name,
    baseURL: normalized.baseURL,
    models,
    allModels,
    modelMetadata,
    metadataWarning,
    catalogSource,
    fetchedAt: new Date().toISOString(),
    modelCapabilities: mapModelCapabilities(models, normalized)
  };
}

async function callChatCompletion({ providerId, provider, body, fetchImpl = fetch, signal = null, onDelta = null }) {
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
        ...(body.stream === true ? { stream: true } : {}),
        ...(body.tools?.length ? {
          tools: body.tools.map((tool) => ({
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters
          }))
        } : {})
      }
    : {
        ...body,
        messages: normalizeOpenAICompatibleMessages(body.messages),
        model: requestModel
      };
  if (requestBody.stream === true) headers.Accept = "text/event-stream";
  console.log(`[ModelAdapter] ${normalized.local ? "本地" : "云端"}模型调用: provider=${normalized.name}, baseURL=${normalized.baseURL}, model=${requestModel}`);
  const requestController = new AbortController();
  const relayAbort = () => requestController.abort();
  if (signal?.aborted) requestController.abort();
  else signal?.addEventListener?.("abort", relayAbort, { once: true });
  let responseTimedOut = false;
  const responseTimer = setTimeout(() => {
    responseTimedOut = true;
    requestController.abort();
  }, FIRST_STREAM_DELTA_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: requestController.signal
    });
    clearTimeout(responseTimer);
    return await readChatCompletionResponse(response, { providerId, normalized, requestModel, requestBody, url, startedAt, onDelta });
  } catch (error) {
    if (responseTimedOut) {
      const timeoutError = new Error("模型在 30 秒内没有建立响应，请检查模型连接、API Key 或供应商状态。");
      timeoutError.code = "MODEL_FIRST_EVENT_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(responseTimer);
    signal?.removeEventListener?.("abort", relayAbort);
  }
}

async function readChatCompletionResponse(response, { providerId, normalized, requestModel, requestBody, url, startedAt, onDelta }) {
  if (requestBody.stream === true && response.ok && response.body && /(?:text\/event-stream|stream)/i.test(response.headers.get("content-type") || "")) {
    return readStreamedChatCompletion(response, {
      providerId,
      provider: normalized,
      requestModel,
      url,
      startedAt,
      apiStyle: normalized.apiStyle,
      onDelta
    });
  }
  const payload = await response.json().catch(error => {
    if (error.name === "AbortError") throw error;
    return {};
  });
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
  if (!response.ok) {
    throw providerHttpError(response, payload, {
      providerId,
      providerName: normalized.name,
      model: requestModel,
      debug: payload._debug
    });
  }
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

async function readStreamedChatCompletion(response, options = {}) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error("模型接口未提供可读取的流式响应。");
  const decoder = new TextDecoder();
  let buffer = "";
  let usage = null;
  let content = "";
  let reasoningContent = "";
  let finishReason = null;
  let firstDeltaSeen = false;
  let firstDeltaTimedOut = false;
  let firstDeltaTimer = setTimeout(() => {
    if (firstDeltaSeen) return;
    firstDeltaTimedOut = true;
    reader.cancel?.().catch?.(() => {});
  }, FIRST_STREAM_DELTA_TIMEOUT_MS);
  const toolCalls = [];
  const emit = (delta) => {
    if (delta && (delta.content || delta.reasoningContent || delta.toolCall)) {
      firstDeltaSeen = true;
      clearTimeout(firstDeltaTimer);
      firstDeltaTimer = null;
      if (typeof options.onDelta === "function") options.onDelta(delta);
    }
  };
  const consumeEvent = (eventText) => {
    const data = eventText
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") return;
    let chunk;
    try { chunk = JSON.parse(data); } catch { return; }
    if (chunk.error || chunk.type === "error") {
      const error = new Error(String(chunk.error?.message || chunk.message || "模型流返回错误。"));
      error.code = "PROVIDER_STREAM_ERROR";
      error.providerId = options.providerId;
      error.model = options.requestModel;
      error.partialText = content;
      throw error;
    }
    usage ||= chunk.usage || null;
    if (options.apiStyle === "anthropic") {
      const delta = chunk.delta || {};
      if (delta.stop_reason) finishReason = delta.stop_reason;
      if (chunk.type === "content_block_start" && chunk.content_block?.type === "tool_use") {
        const index = toolCalls.length;
        const toolCall = {
          index,
          id: String(chunk.content_block.id || `tool-${index}`),
          name: String(chunk.content_block.name || ""),
          arguments: ""
        };
        toolCalls.push(toolCall);
        emit({ toolCall });
      }
      if (chunk.type === "content_block_delta" && delta.type === "text_delta" && delta.text) {
        content += delta.text;
        emit({ content: delta.text });
      }
      if (chunk.type === "content_block_delta" && delta.type === "thinking_delta" && delta.thinking) {
        reasoningContent += delta.thinking;
        emit({ reasoningContent: delta.thinking });
      }
      if (chunk.type === "content_block_delta" && delta.type === "input_json_delta" && delta.partial_json) {
        const target = toolCalls.at(-1);
        if (target) target.arguments += delta.partial_json;
      }
      return;
    }
    const choice = chunk.choices?.[0] || {};
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    const nextContent = typeof delta.content === "string" ? delta.content : "";
    const nextReasoning = String(delta.reasoning_content || delta.reasoning || "");
    if (nextContent) {
      content += nextContent;
      emit({ content: nextContent });
    }
    if (nextReasoning) {
      reasoningContent += nextReasoning;
      emit({ reasoningContent: nextReasoning });
    }
    for (const item of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = Number(item.index || 0);
      const target = toolCalls[index] ||= { index, id: "", name: "", arguments: "" };
      if (item.id) target.id = String(item.id);
      if (item.function?.name) target.name += String(item.function.name);
      if (item.function?.arguments) target.arguments += String(item.function.arguments);
      emit({ toolCall: { ...target } });
    }
  };
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || "";
      events.forEach(consumeEvent);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeEvent(buffer);
  } finally {
    if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
    await reader.cancel().catch(() => {});
  }
  if (firstDeltaTimedOut) {
    const error = new Error("模型在 30 秒内没有返回首个流式内容，请检查模型连接、API Key 或供应商状态。");
    error.code = "MODEL_FIRST_EVENT_TIMEOUT";
    throw error;
  }
  const message = {
    role: "assistant",
    content,
    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    ...(toolCalls.length ? {
      tool_calls: toolCalls.filter((item) => item.name).map((item) => ({
        id: item.id || `tool-${item.index}`,
        type: "function",
        function: { name: item.name, arguments: item.arguments || "{}" }
      }))
    } : {})
  };
  return {
    choices: [{ message, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
    _debug: {
      providerId: options.providerId,
      providerName: options.provider?.name || options.providerId,
      model: options.requestModel,
      baseURL: options.provider?.baseURL || "",
      url: options.url,
      local: Boolean(options.provider?.local),
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - Number(options.startedAt || Date.now()),
      usage: usage || null,
      sentAt: options.startedAt,
      receivedAt: Date.now()
    }
  };
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
  const startedAt = Date.now();
  const normalized = normalizeProvider(providerId, provider);
  const body = {
    model: normalized.model,
    messages: [
      { role: "system", content: "You are a connection verifier. Follow the user's output format exactly." },
      { role: "user", content: `只回复 ${MODEL_PROBE_TOKEN}，不要添加其他内容。` }
    ],
    max_tokens: 512,
    stream: false
  };
  let payload = await callChatCompletion({ providerId, provider: normalized, body, fetchImpl, signal });
  let probeAttempts = 1;
  if (!completionText(payload) && payload.choices?.[0]?.finish_reason === "length") {
    body.max_tokens = 4096;
    probeAttempts += 1;
    payload = await callChatCompletion({ providerId, provider: normalized, body, fetchImpl, signal });
  }
  const text = completionText(payload);
  if (!text) {
    const error = new Error(payload.choices?.[0]?.finish_reason === "length"
      ? "模型连接已建立，但连接验证的输出预算耗尽，尚未得到正文；不能据此判定 API Key 或路由无效。"
      : "模型接口已响应，但没有返回可用的文本内容。");
    error.code = "MODEL_PROBE_EMPTY_TEXT";
    error.debug = { ...payload._debug, finishReason: payload.choices?.[0]?.finish_reason,
      completionTokens: payload.usage?.completion_tokens, probeAttempts, probeTokenBudget: body.max_tokens };
    throw error;
  }
  return {
    providerId,
    providerName: normalized.name,
    model: normalized.model,
    baseURL: normalized.baseURL,
    verified: true,
    verificationScope: "direct_text",
    verifiedApiStyle: normalized.apiStyle,
    probeAttempts,
    probeTokenBudget: body.max_tokens,
    instructionCompliant: text.includes(MODEL_PROBE_TOKEN),
    verifiedAt: new Date().toISOString(),
    latencyMs: Date.now() - startedAt,
    statusCode: payload._debug?.status ?? null
  };
}

async function probeReasoningControl({ providerId, provider, fetchImpl = fetch, signal = null }) {
  const normalized = normalizeProvider(providerId, provider);
  const inferred = inferredModelCapabilities(normalized.model, normalized);
  if (inferred.reasoningMode !== "native-candidate") return inferred;
  const probeLevel = inferred.reasoningLevels.includes("low") ? "low" : inferred.reasoningLevels[0];
  try {
    const payload = await callChatCompletion({
      providerId,
      provider: normalized,
      body: {
        model: normalized.model,
        messages: [
          { role: "system", content: "You are a connection verifier. Follow the user's output format exactly." },
          { role: "user", content: `只回复 ${MODEL_PROBE_TOKEN}，不要添加其他内容。` }
        ],
        reasoning_effort: probeLevel,
        max_tokens: 512,
        stream: false
      },
      fetchImpl,
      signal
    });
    if (!completionText(payload)) throw new Error("思考参数请求没有返回正文，不能标记为已验证。");
    return {
      ...inferred,
      reasoningMode: "native",
      reasoningVerified: true,
      reasoningVerifiedLevel: probeLevel,
      reasoningVerifiedAt: new Date().toISOString()
    };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      ...inferred,
      reasoningMode: "prompt",
      reasoningLevels: [...PROMPT_REASONING_LEVELS],
      reasoningTransport: "system-prompt",
      reasoningProbeError: error?.message || String(error)
    };
  }
}

async function verifyProviderConnection({ providerId, provider, fetchImpl = fetch, signal = null }) {
  const normalized = normalizeProvider(providerId, provider);
  const probe = await probeProvider({ providerId, provider: normalized, fetchImpl, signal });
  let models = [];
  let allModels = [];
  let modelListWarning = "";
  let modelListVerified = false;
  try {
    const discoveryTimeout = AbortSignal.timeout(8000);
    const listed = await listProviderModels({ providerId, provider: normalized, fetchImpl,
      signal: signal ? AbortSignal.any([signal, discoveryTimeout]) : discoveryTimeout });
    models = listed.models;
    allModels = listed.allModels;
    modelListVerified = true;
  } catch (error) {
    signal?.throwIfAborted();
    modelListWarning = error?.message || String(error);
  }
  if (!models.includes(normalized.model)) {
    if (modelListVerified) modelListWarning = "所选模型未出现在模型目录中，但已通过真实正文请求验证。目录不代表账号的全部可调用型号或接入点。";
    models = [normalized.model, ...models];
  }
  signal?.throwIfAborted();
  const reasoningControl = await probeReasoningControl({ providerId, provider: normalized, fetchImpl, signal });
  const modelCapabilities = mapModelCapabilities(models.length ? models : [normalized.model], normalized);
  modelCapabilities[normalized.model] = reasoningControl;
  return { ...probe, models, allModels, modelCapabilities, reasoningControl, modelListVerified, modelListWarning };
}

module.exports = {
  MODEL_PROBE_TOKEN,
  PRESET_PROVIDERS,
  callChatCompletion,
  completionText,
  conversationModelIds,
  deepSeekModelMetadataFromHtml,
  inferredModelCapabilities,
  isConversationModelId,
  listProviderModels,
  mapModelCapabilities,
  normalizeOpenAICompatibleMessages,
  normalizeProvider,
  probeProvider,
  probeReasoningControl,
  verifyProviderConnection
};
