import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";

export default function TermsPage() {
  return (
    <div className="site-shell min-h-[100dvh]">
      <header className="border-b border-[var(--page-line)]">
        <div className="container flex h-16 items-center justify-between">
          <Link href="/">
            <BrandMark />
          </Link>
          <Link href="/" className="text-sm text-[var(--page-muted)]">
            返回首页
          </Link>
        </div>
      </header>
      <main className="container section max-w-3xl">
        <h1 className="display-sm">使用条款</h1>
        <p className="mt-4 rounded-[14px] border border-[var(--page-line)] bg-white/70 px-4 py-3 text-sm text-[var(--page-muted)]">
          占位页面。正式使用条款将在公开发布前补充。使用开发者版本时，请同时遵守仓库许可证与本地安全策略。
        </p>
        <div className="mt-8 space-y-4 text-[0.98rem] leading-relaxed text-[var(--page-muted)]">
          <p>
            白球 AI 当前提供 Windows 桌面端能力，包括对话、文件与工具调用等。部分高权限操作（例如系统相关命令）会经过权限检查，不应被理解为可无限制控制系统。
          </p>
          <p>
            软件按现状提供。开发者版本、试用与会员能力可能随版本变化。具体许可状态以客户端内显示为准。
          </p>
        </div>
      </main>
    </div>
  );
}
