"use strict";

function compactText(value = "", limit = 1200) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function visibleTurns(turns = [], limit = 8) {
  return (Array.isArray(turns) ? turns : [])
    .filter((item) => item && ["user", "assistant"].includes(String(item.role || "")))
    .map((item) => ({ role: item.role, text: compactText(item.text, 500) }))
    .filter((item) => item.text)
    .slice(-limit);
}

function candidate(id, label, confidence, evidence) {
  return { id, label, confidence, evidence };
}

function option(label, recommended, candidateIds) {
  return { label, recommended, candidateIds };
}

const SIMPLE_CHAT = /^(?:你好|您好|嗨|hi|hello|在吗|谢谢|多谢|好的?|可以|收到)[！!。,.，\s]*$/i;
const IMAGE_TOPIC = /(?:图片|图像|照片|海报|插画|头像|商品图|绘图|画图|生图|美女|风景|image|photo|picture)/i;
const IMAGE_GENERATION = /(?:生成|生产|画|绘制|创作|做|来|给我).{0,12}(?:一张|几张|个)?[^。！？\n]{0,30}(?:图片|图像|照片|海报|插画|头像|商品图)|(?:生图|文生图|image\s*generation)/i;
const MODEL_SWITCH = /(?:切换|换|改用|使用|用).{0,16}(?:大模型|模型|gpt)|(?:gpt).{0,16}(?:怎么样|可以吗|呢|行吗|能不能)/i;
const CAPABILITY_QUESTION = /(?:可以|能|能不能|可不可以|支持|会不会|是否).{0,18}(?:生成|生产|画|看|识别|理解).{0,12}(?:图片|图像|照片)|(?:给我).{0,12}(?:生成|生产|画).{0,8}(?:图片|图像).{0,4}(?:吗|么|？|\?)/i;

function hasConcreteImageBrief(text = "") {
  const value = compactText(text);
  if (!IMAGE_GENERATION.test(value)) return false;
  if (/(?:随便|测试|美女|人物|风景|商品|海报|头像|插画|写实|动漫|油画|尺寸|比例|背景|风格|主题|内容)/i.test(value)) return true;
  const withoutCommand = value.replace(IMAGE_GENERATION, "").replace(/[，。！？,.!?\s]/g, "");
  return withoutCommand.length >= 8;
}

function recentImageContext(turns = []) {
  return visibleTurns(turns)
    .slice(-6)
    .some((item) => IMAGE_TOPIC.test(item.text) && /(?:生成|生产|生图|看图|识别|理解|comfyui|图片)/i.test(item.text));
}

class IntentPredictionService {
  constructor({ onPredict = null } = {}) {
    this.onPredict = typeof onPredict === "function" ? onPredict : null;
  }

  predict({ input = "", recentTurns = [], capabilitySnapshot = {} } = {}) {
    const text = compactText(input, 2000);
    const context = visibleTurns(recentTurns);
    if (!text || SIMPLE_CHAT.test(text)) return null;

    let prediction = null;
    if (MODEL_SWITCH.test(text) && recentImageContext(context)) {
      prediction = {
        action: "clarify",
        workingGoal: "继续当前图片相关需求",
        confidence: 0.66,
        candidates: [
          candidate("generate_image", "继续直接生成图片", 0.66, "上一轮正在讨论图片生成"),
          candidate("understand_image", "切换后识别或分析上传图片", 0.2, "GPT 也可能指视觉理解"),
          candidate("switch_chat_model", "把整个对话模型切换为 GPT", 0.14, "当前句明确提到了切换模型")
        ],
        blocker: {
          dimension: "image_model_intent",
          label: "图片与模型",
          question: "你说切换到 GPT，主要想解决哪件事？",
          reason: "直接生图、看懂上传图片和切换聊天模型是三项不同能力，处理路径完全不同。",
          impact: "high",
          options: [
            option("继续直接生成一张测试图片", true, ["generate_image"]),
            option("识别或分析我上传的图片", false, ["understand_image"]),
            option("切换整个白球对话模型", false, ["switch_chat_model"])
          ]
        }
      };
    } else if (IMAGE_GENERATION.test(text) && !hasConcreteImageBrief(text)) {
      prediction = {
        action: "clarify",
        workingGoal: "处理图片相关请求",
        confidence: CAPABILITY_QUESTION.test(text) ? 0.58 : 0.68,
        candidates: [
          candidate("generate_image", "现在生成一张图片", 0.58, "句子包含生成图片动作"),
          candidate("image_capability", "了解当前是否支持图片生成", 0.27, "句式可能是在询问能力"),
          candidate("understand_image", "分析一张已有图片", 0.15, "图片请求也可能指视觉理解")
        ],
        blocker: {
          dimension: "image_request_kind",
          label: "图片需求",
          question: "你这次希望我直接生成图片，还是先确认图片能力？",
          reason: "生成新图片与识别已有图片不是同一项能力，确认后才能走正确工具。",
          impact: "high",
          options: [
            option("直接生成一张测试图片", true, ["generate_image"]),
            option("只确认当前能否生成图片", false, ["image_capability"]),
            option("分析我上传的图片", false, ["understand_image"])
          ]
        }
      };
    }

    if (!prediction) return null;
    const result = {
      ...prediction,
      source: "whiteball_intent_prediction",
      capabilitySnapshot: {
        imageUnderstanding: capabilitySnapshot.imageUnderstanding === true,
        imageGeneration: capabilitySnapshot.imageGeneration === true
      }
    };
    this.onPredict?.(result);
    return result;
  }
}

module.exports = {
  IntentPredictionService,
  hasConcreteImageBrief,
  recentImageContext,
  visibleTurns
};
