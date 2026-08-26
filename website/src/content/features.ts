export type Feature = {
  id: string;
  title: string;
  body: string;
  visual: "chat" | "files" | "tools" | "plan" | "sheet" | "skills";
  span?: "wide" | "tall" | "normal";
};

export const features: Feature[] = [
  {
    id: "understand",
    title: "听懂目标，而不是只接问题",
    body: "你可以直接说“整理桌面工作文件”或“分析这份表格”。白球会先理解目标，再决定下一步怎么做。",
    visual: "chat",
    span: "wide",
  },
  {
    id: "files",
    title: "读取、整理并生成真实文件",
    body: "支持写入文本、创建文件夹、查找与整理桌面文件，并在允许范围内生成可打开的结果文件。",
    visual: "files",
  },
  {
    id: "tools",
    title: "需要动手时，会继续行动",
    body: "不是停在一段建议上。白球可以调用本地工具：打开路径、生成 Excel、执行安全命令、联网检索资料。",
    visual: "tools",
    span: "tall",
  },
  {
    id: "plan",
    title: "多步骤任务会拆开推进",
    body: "复杂目标会进入理解、规划、执行与验证的流程。你可以在任务看板里看到进度，而不是只拿到一段回复。",
    visual: "plan",
  },
  {
    id: "sheet",
    title: "表格与内容也能落地",
    body: "上传表格或资料后，白球可以分析内容、整理结论，并生成可继续使用的总结或 xlsx 文件。",
    visual: "sheet",
  },
  {
    id: "skills",
    title: "能力可以扩展",
    body: "通过 Skills 安装、优化与回滚，白球能学习新的本地技能；同时保留长期记忆与人格设定，让协作更连续。",
    visual: "skills",
    span: "wide",
  },
];

export type JourneyStep = {
  id: string;
  label: string;
  title: string;
  body: string;
};

export const journeySteps: JourneyStep[] = [
  {
    id: "goal",
    label: "提出目标",
    title: "你说出想完成的事",
    body: "例如：帮我整理这些资料，并生成一份清晰的总结。",
  },
  {
    id: "plan",
    label: "拆解任务",
    title: "白球理解并规划步骤",
    body: "把模糊需求拆成可执行动作：读取、归类、提炼、输出。",
  },
  {
    id: "tools",
    label: "调用能力",
    title: "需要工具时继续行动",
    body: "读写文件、生成表格、打开结果，把建议变成真实操作。",
  },
  {
    id: "result",
    label: "交付结果",
    title: "你拿到可继续使用的成果",
    body: "总结、清单或文件回到窗口里，任务进度可追踪、可验证。",
  },
];

export type UseCase = {
  id: string;
  title: string;
  body: string;
  prompt: string;
};

export const useCases: UseCase[] = [
  {
    id: "organize",
    title: "整理一堆零散资料",
    body: "把桌面或文件夹里散落的文件归类、命名、备份，留下真正有用的部分。",
    prompt: "帮我整理桌面上的工作文件",
  },
  {
    id: "read",
    title: "阅读长文档并提炼重点",
    body: "上传文档或资料后，白球帮你抓出结构、结论与可执行要点。",
    prompt: "阅读这些资料并生成清晰总结",
  },
  {
    id: "plan-day",
    title: "把模糊想法变成计划",
    body: "从一句“本周要做完这些事”，整理成可勾选的待办与步骤。",
    prompt: "把今天的待办整理成清单",
  },
  {
    id: "repeat",
    title: "协助重复性电脑任务",
    body: "创建文件夹、生成文件、打开结果，减少在多个窗口之间来回切换。",
    prompt: "按这个模板生成本周工作文件",
  },
  {
    id: "create",
    title: "生成和修改内容",
    body: "创建文本、HTML 小工具或表格结果，并在本机直接打开验证。",
    prompt: "生成一个可运行的本地小工具",
  },
  {
    id: "life",
    title: "处理学习、工作与生活信息",
    body: "搜索资料、记住长期偏好、切换模型与推理等级，按任务轻重调节节奏。",
    prompt: "帮我检索资料并记住我的工作偏好",
  },
];

export const workflowDemo = {
  task: "帮我整理这些资料，并生成一份清晰的总结。",
  stages: [
    {
      id: "receive",
      label: "接收目标",
      detail: "识别任务意图：整理资料 + 输出总结",
    },
    {
      id: "analyze",
      label: "分析文件",
      detail: "读取附件与文本内容，提取主题与结构",
    },
    {
      id: "organize",
      label: "组织信息",
      detail: "归类要点，去掉重复，形成清晰大纲",
    },
    {
      id: "act",
      label: "调用能力",
      detail: "写入总结文件，必要时生成表格或打开路径",
    },
    {
      id: "deliver",
      label: "输出结果",
      detail: "在执行舞台交付可验证成果，并保留任务记录",
    },
  ],
};

export const productUi = {
  emptyTitle: "把任务交给白球",
  emptyBody:
    "这不是只能聊天的窗口。描述目标后，白球会规划、调用本地能力，并把可验证结果带回这里。",
  tips: ["整理桌面文件", "分析表格", "整理待办清单"],
  sessions: ["本周工作整理", "表格结论", "学习计划"],
  status: ["内核就绪", "模型 DeepSeek", "会话待命"],
};
