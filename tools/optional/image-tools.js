"use strict";

function createTools() {
  return [
    {
      id: "image_read",
      name: "读取图片",
      description: "读取本地图片的真实格式、尺寸和文件大小，不上传图片。",
      category: "file",
      parameters: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" } }
      },
      permission: { level: "file.read", scope: "file" },
      async execute(params, context) {
        const result = await context.runtime.executeImageRead(params);
        return {
          success: result?.success === true,
          result,
          error: result?.success === true ? null : result?.error,
          evidence: [{ type: "local-image-read", tool: "image_read", ...(result?.evidence || {}) }]
        };
      }
    },
    {
      id: "image_edit",
      name: "转换图片",
      description: "在本地缩放图片并转换 PNG/JPEG 格式，写入后重新读取校验。",
      category: "file",
      parameters: {
        type: "object",
        required: ["path", "outputPath"],
        properties: {
          path: { type: "string" },
          outputPath: { type: "string" },
          width: { type: "integer", minimum: 1, maximum: 16384 },
          height: { type: "integer", minimum: 1, maximum: 16384 },
          quality: { type: "integer", minimum: 1, maximum: 100 }
        }
      },
      permission: { level: "file.write", scope: "file" },
      async execute(params, context) {
        const result = await context.runtime.executeImageEdit(params);
        return {
          success: result?.success === true,
          result,
          error: result?.success === true ? null : result?.error,
          evidence: [{ type: "local-image-edit", tool: "image_edit", ...(result?.evidence || {}) }]
        };
      }
    }
  ];
}

module.exports = { createTools };
