"use strict";

const CONTENT_ARTIFACTS = Object.freeze([
  Object.freeze({ type: "video", match: /视频|短视频|影片|动画/i, capability: "video_generation", tools: Object.freeze(["create_video", "render_video", "ffmpeg_render"]) }),
  Object.freeze({ type: "image", match: /图片|海报|配图|封面|插画/i, capability: "image_generation", tools: Object.freeze(["generate_image", "create_image"]) }),
  Object.freeze({ type: "audio", match: /音频|配音|播客|语音/i, capability: "audio_generation", tools: Object.freeze(["generate_audio", "text_to_speech"]) }),
  Object.freeze({ type: "presentation", match: /PPT|演示文稿|幻灯片/i, capability: "presentation_generation", tools: Object.freeze(["create_presentation", "write_pptx"]) }),
  Object.freeze({ type: "spreadsheet", match: /Excel|xlsx|电子表格|工作簿/i, capability: "spreadsheet_generation", tools: Object.freeze(["write_xlsx"]) }),
  Object.freeze({ type: "document", match: /Word|docx|文档文件/i, capability: "document_generation", tools: Object.freeze(["skill_word", "write_document", "write_text_file"]) })
]);

function normalizeTools(tools = []) {
  return (Array.isArray(tools) ? tools : []).map((tool) => ({
    id: String(tool?.id || tool?.name || "").trim(),
    capabilities: Array.isArray(tool?.capabilities) ? tool.capabilities.map((item) => String(item || "").trim().toLowerCase()) : []
  })).filter((tool) => tool.id);
}

function contentArtifactProfile(text = "") {
  const value = String(text || "").trim();
  const matched = CONTENT_ARTIFACTS.find((item) => item.match.test(value));
  return matched || Object.freeze({ type: "text", capability: "text_generation", tools: Object.freeze([]) });
}

class ContentPlanner {
  createPlan({ taskGoal = "", permissions = {}, tools = [] } = {}) {
    const profile = contentArtifactProfile(taskGoal);
    const availableTools = normalizeTools(tools);
    const selected = availableTools.find((tool) => profile.tools.includes(tool.id)
      || tool.capabilities.includes(profile.capability));
    const permissionGranted = permissions.allowTools === true
      && (profile.type === "text" || permissions.allowFileWrite === true);
    const available = Boolean(selected && permissionGranted);
    const missingCapabilities = available ? [] : [profile.capability];
    const steps = available
      ? [{
          id: "content-produce",
          title: `生成${profile.type}内容产物`,
          action: "produce",
          intent: `content.${profile.type}`,
          capability: profile.capability,
          toolId: selected.id,
          args: { request: taskGoal },
          executable: true,
          requiresPermission: true
        }]
      : [{
          id: "content-capability-acquisition",
          title: `获取并验证${profile.capability}能力`,
          action: "acquire_skill",
          intent: "skill.acquire_for_goal",
          capability: profile.capability,
          toolId: "",
          args: { originalGoal: taskGoal, requiredCapability: profile.capability },
          executable: false,
          requiresPermission: true
        }];
    return Object.freeze({
      planType: "content_artifact",
      contentType: profile.type,
      taskGoal: String(taskGoal || "").trim(),
      requiredCapabilities: Object.freeze([profile.capability]),
      missingCapabilities: Object.freeze(missingCapabilities),
      status: available ? "ready" : "capability_missing",
      resumeOriginalGoal: true,
      steps: Object.freeze(steps.map((step) => Object.freeze(step)))
    });
  }
}

module.exports = { CONTENT_ARTIFACTS, contentArtifactProfile, normalizeTools, ContentPlanner };
