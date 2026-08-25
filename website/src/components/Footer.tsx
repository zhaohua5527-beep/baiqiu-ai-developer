import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { site } from "@/content/site";

export function Footer() {
  return (
    <footer className="border-t border-[var(--page-line)] py-12">
      <div className="container grid gap-8 md:grid-cols-[1.2fr_0.8fr] md:items-start">
        <div>
          <BrandMark />
          <p className="mt-4 max-w-md text-sm leading-relaxed text-[var(--page-muted)]">
            {site.footer.blurb}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-6 text-sm">
          <div className="space-y-2">
            <p className="font-medium">产品</p>
            <a
              href="#capabilities"
              className="block text-[var(--page-muted)] hover:text-[var(--page-fg)]"
            >
              产品能力
            </a>
            <a
              href="#product"
              className="block text-[var(--page-muted)] hover:text-[var(--page-fg)]"
            >
              产品界面
            </a>
          </div>
          <div className="space-y-2">
            <p className="font-medium">法律</p>
            <Link
              href={site.privacyUrl}
              className="block text-[var(--page-muted)] hover:text-[var(--page-fg)]"
            >
              隐私政策
            </Link>
            <Link
              href={site.termsUrl}
              className="block text-[var(--page-muted)] hover:text-[var(--page-fg)]"
            >
              使用条款
            </Link>
          </div>
        </div>
      </div>
      <div className="container mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--page-line)] pt-6 text-sm text-[var(--page-muted)]">
        <p>
          © {site.year} {site.name}
        </p>
        <p className="mono text-xs">
          v{site.version} · {site.platform}
        </p>
      </div>
    </footer>
  );
}
