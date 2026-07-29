export const site = {
  name: "白球 AI",
  nameEn: "Baiqiu AI",
  tagline: "帮你把事情真正做完的个人 AI 助理",
  version: "1.1.20",
  year: 2026,
  platform: "Windows",
  platformStatus: "Windows 桌面端",
  downloadUrl: "/download",
  docsUrl: null as string | null,
  contactUrl: null as string | null,
  privacyUrl: "/privacy",
  termsUrl: "/terms",
  canonical: "https://baiqiu.ai",
  title: "白球 AI｜帮你把事情真正做完的个人 AI 助理",
  description:
    "白球 AI 是面向个人用户的 Windows AI 助理。它理解你的目标，整理信息，调用本地工具，并把复杂任务一步步推进到可验证的结果。",
  keywords: [
    "白球 AI",
    "Baiqiu AI",
    "Windows AI 助理",
    "桌面 AI",
    "个人 AI 助理",
    "OpenClaw",
  ],
  hero: {
    titleLines: ["把想法交给白球。", "让结果回到你手上。"],
    subtitle:
      "白球理解目标、组织信息、调用工具，把复杂任务推进到可验证的结果。",
    primaryCta: { label: "看看白球怎么完成", href: "#journey" },
  },
  brandStatement: {
    headline: "不是多聊几句，是继续往下做。",
    body: "从理解目标到调用本地能力，白球把一次请求变成可观察、可验证的执行过程。",
  },
  brandClose: {
    headline: "把复杂过程交给白球，把可用结果留给自己。",
    body: "桌面文件、表格、资料和计划，都能在同一条任务轨道里继续推进。",
  },
  finalCta: {
    title: "让白球从一个目标开始。",
    body: "先看看它如何理解任务、调用能力，再把结果带回你的桌面。",
    primary: { label: "探索白球 AI", href: "#product" },
    downloadLabel: "Windows 版本准备中",
  },
  desktop: {
    title: "不是网页里的聊天框，是 Windows 桌面上的个人助理。",
    body: "白球 AI 以本地桌面客户端运行，围绕会话、执行舞台与运行态势组织工作。它能读写文件、整理桌面、生成表格、打开结果，并把任务进度留在本机工作流中。",
    points: [
      {
        title: "与电脑工作环境结合",
        body: "面向桌面文件、文件夹、表格与本地任务，而不是只停在浏览器标签页。",
      },
      {
        title: "承载更完整的工作流程",
        body: "从理解目标、规划步骤，到调用工具、验证结果，过程可在同一窗口跟进。",
      },
      {
        title: "可配置的模型与运行时",
        body: "支持切换模型线路与推理等级，并可使用本机 OpenClaw 或 Hermes 内核路径。",
      },
    ],
  },
  nav: [
    { label: "能力", href: "#capabilities" },
    { label: "如何完成", href: "#journey" },
    { label: "使用场景", href: "#usecases" },
    { label: "产品界面", href: "#product" },
    { label: "常见问题", href: "#faq" },
  ],
  footer: {
    blurb: "面向个人用户的 Windows AI 助理，帮你把复杂任务推进到结果。",
  },
} as const;

export type SiteConfig = typeof site;
