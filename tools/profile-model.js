function createTools() {
  return [
    {
      id: "switch_model",
      name: "切换模型",
      description: "根据用户要求切换当前默认模型供应商。",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", description: "模型供应商 id，例如 deepseek、openai、kimi" }
        },
        required: ["provider"]
      },
      permission: { level: "settings.write", scope: "model" },
      async execute(params, context) {
        const result = context.runtime.switchModel(params.provider);
        return { success: true, result, error: null, evidence: [{ type: "model", action: "switch", provider: params.provider }] };
      }
    },
    {
      id: "list_models",
      name: "列出模型",
      description: "列出白球 AI 当前可用的模型供应商与默认模型。",
      parameters: { type: "object", properties: {}, required: [] },
      permission: { level: "settings.read", scope: "model" },
      async execute(_params, context) {
        return { success: true, result: context.runtime.listModels(), error: null, evidence: [{ type: "model", action: "list" }] };
      }
    },
    {
      id: "switch_reasoning",
      name: "切换推理等级",
      description: "根据用户要求切换推理等级，例如 minimal、low、medium、high、maximum。",
      parameters: {
        type: "object",
        properties: {
          reasoning: { type: "string", description: "推理等级：off、minimal、low、medium、high、extra_high、maximum" }
        },
        required: ["reasoning"]
      },
      permission: { level: "settings.write", scope: "model" },
      async execute(params, context) {
        const result = context.runtime.switchReasoning(params.reasoning);
        return { success: true, result, error: null, evidence: [{ type: "model", action: "switch_reasoning", reasoning: params.reasoning }] };
      }
    }
  ];
}

module.exports = { createTools };
