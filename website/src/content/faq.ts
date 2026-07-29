export type FaqItem = {
  id: string;
  question: string;
  answer: string;
};

export const faqItems: FaqItem[] = [
  {
    id: "what",
    question: "白球 AI 是什么？",
    answer:
      "白球 AI 是面向个人用户的 Windows 桌面 AI 助理。它不只聊天，还会理解目标、规划步骤、调用本地工具，并把任务推进到可验证的结果。",
  },
  {
    id: "diff",
    question: "它和普通聊天 AI 有什么不同？",
    answer:
      "普通聊天工具通常停在文字建议。白球把“执行”放进产品主路径：可以读写文件、整理桌面、生成表格、打开结果，并在任务流程中跟踪进度。",
  },
  {
    id: "help",
    question: "白球 AI 可以帮助我做什么？",
    answer:
      "例如整理桌面文件、分析表格、生成总结与待办、创建本地文件或小工具、联网检索资料，以及通过 Skills 扩展新的本地能力。具体能力以当前版本已实现的工具与产品层为准。",
  },
  {
    id: "platform",
    question: "支持哪些系统？",
    answer:
      "当前产品以 Windows 桌面端为主，提供 NSIS 安装包、zip 与 portable 分发形态。其他系统不在当前宣传范围内。",
  },
  {
    id: "model",
    question: "是否需要配置 AI 模型？",
    answer:
      "需要选择或配置可用的模型线路。白球支持多种模型供应商切换，也可走本机 OpenClaw 网关路径；同时可调节推理等级，以匹配不同任务强度。",
  },
  {
    id: "start",
    question: "如何开始使用？",
    answer:
      "可以从 GitHub 仓库获取开发者版本与源码，在 Windows 上启动桌面客户端后直接描述任务。公开下载入口若尚未稳定发布，页面会标明准备中，避免失效链接。",
  },
];
