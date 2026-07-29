export const site = {
  name: "白球 AI",
  nameEn: "Baiqiu AI",
  tagline: "帮你把事情真正做完的个人 AI 助理",
  version: "1.1.20",
  year: 2026,
  platform: "Windows",
  platformStatus: "Windows 桌面端",
  githubUrl: "https://github.com/zhaohua5527-beep/baiqiu-ai-developer",
  downloadUrl: null as string | null,
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
    titleLines: ["一个 AI，", "帮你把事情真正做完。"],
    subtitle:
      "白球 AI 不止回答问题。它理解你的目标，整理信息，调用工具，并把复杂任务一步步推进到结果。",
    primaryCta: { label: "认识白球 AI", href: "#capabilities" },
    secondaryCta: {
      label: "查看 GitHub",
      href: "https://github.com/zhaohua5527-beep/baiqiu-ai-developer",
      external: true,
    },
  },
  brandStatement: {
    headline: "普通 AI 给你答案，白球 AI 帮你继续往下做。",
    body: "描述一个目标，白球会拆解步骤、调用本地能力、验证结果，再把可继续使用的成果交还给你。",
  },
  brandClose: {
    headline: "把想法交给白球，把结果留给自己。",
    body: "从桌面文件到表格分析，从模糊计划到可执行清单，白球把执行过程留在你的电脑工作流里。",
  },
  finalCta: {
    title: "开始认识白球 AI",
    body: "探索产品能力，或在 GitHub 查看项目源码与开发者版本。",
    primary: { label: "探索白球 AI", href: "#product" },
    secondary: {
      label: "在 GitHub 查看项目",
      href: "https://github.com/zhaohua5527-beep/baiqiu-ai-developer",
      external: true,
    },
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
    { label: "产品能力", href: "#capabilities" },
    { label: "使用场景", href: "#usecases" },
    { label: "产品界面", href: "#product" },
    { label: "常见问题", href: "#faq" },
  ],
  footer: {
    blurb: "面向个人用户的 Windows AI 助理，帮你把复杂任务推进到结果。",
  },
} as const;

export type SiteConfig = typeof site;
