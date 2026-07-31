"use strict";

const MANIFEST = {
  "name": "professional_skill_f5db6db3301b",
  "description": "白球已验证专业技能：进程管理",
  "parameters": {
    "type": "object",
    "properties": {
      "request": {
        "type": "string",
        "description": "用户当前任务"
      },
      "host": {
        "type": "string",
        "description": "主机地址"
      },
      "port": {
        "type": "number",
        "description": "端口"
      },
      "timeoutMs": {
        "type": "number",
        "description": "超时时间"
      }
    },
    "required": []
  },
  "permission": {
    "level": "skill.execute",
    "scope": "skills"
  }
};

const CONTENT = "# 进程管理\n\n## 使用场景\n当用户的问题涉及“进程管理”或相关专业工作时，优先调用本技能。\n\n## 核心规则\n- 先确认目标、约束、输入资料和期望输出。\n- 回答要给出可执行步骤，避免只讲概念。\n- 如果任务能由白球本地动作完成，必须优先给出 baiqiu-action 动作块，并让白球执行。\n- 对重复任务，要沉淀为固定流程：识别条件、输入文件、执行动作、输出结果、复查标准。\n- 涉及数据、表格、图片、运营、业务判断时，优先给出检查清单和落地动作。\n- 不确定的结论要标注依据不足，并提示需要补充哪些资料。\n\n## 操作流程\n1. 提取用户目标和已有资料。\n2. 按专业资料中的方法拆解问题。\n3. 输出结论、执行步骤、风险点和下一步建议。\n4. 如果用户上传文件或图片，结合文件内容进行判断。\n5. 如果用户要求“以后都这样做”或“记住流程”，把流程保存成长期记忆或自学习技能。\n\n## 学习来源\n- 增加进程管理技能\n\n## 原始资料摘要\n增加进程管理技能";
async function execute(params = {}) {
  return { success: true, result: { skill: "进程管理", request: String(params.request || ""), procedure: CONTENT }, evidence: [{ type: "skill_runtime", skillId: "professional_skill_f5db6db3301b" }] };
}

module.exports = { MANIFEST, execute };
