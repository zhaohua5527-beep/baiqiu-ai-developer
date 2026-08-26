import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";

export default function PrivacyPage() {
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
        <h1 className="display-sm">隐私政策</h1>
        <p className="mt-4 rounded-[14px] border border-[var(--page-line)] bg-white/70 px-4 py-3 text-sm text-[var(--page-muted)]">
          占位页面。正式法律文本将在公开发布前补充。当前版本以产品内实际说明与代码行为为准。
        </p>
        <div className="prose mt-8 space-y-4 text-[0.98rem] leading-relaxed text-[var(--page-muted)]">
          <p>
            白球 AI 是 Windows 桌面客户端。涉及模型调用、会员激活或联网搜索时，可能需要与外部服务通信。本地文件读写与桌面整理等能力在用户发起任务后执行。
          </p>
          <p>
            购买与兑换流程中如收集姓名或手机号，产品界面说明用于购买记录、售后和设备激活核验，不用于无关用途。更完整的数据处理说明将在正式隐私政策中发布。
          </p>
        </div>
      </main>
    </div>
  );
}
