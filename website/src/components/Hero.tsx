"use client";

import dynamic from "next/dynamic";
import { ArrowUpRight } from "lucide-react";
import { site } from "@/content/site";

const BaiqiuMascot = dynamic(
  () =>
    import("@/components/BaiqiuMascot").then((mod) => mod.BaiqiuMascot),
  {
    ssr: false,
    loading: () => (
      <div className="mascot-stage grid place-items-center">
        <div className="loader-orbit" aria-hidden="true" />
        <span className="sr-only">白球吉祥物加载中</span>
      </div>
    ),
  },
);

export function Hero() {
  return (
    <section className="container hero-grid" aria-labelledby="hero-title">
      <div className="relative z-[2]">
        <div className="eyebrow mb-5">
          <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-[var(--bq-ice)]" />
          {site.platformStatus} · v{site.version}
        </div>
        <h1 id="hero-title" className="display text-[#121820]">
          {site.hero.titleLines.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </h1>
        <p className="lede mt-5">{site.hero.subtitle}</p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <a href={site.hero.primaryCta.href} className="btn btn-primary has-orbit">
            <span className="orbit-ring" aria-hidden="true" />
            {site.hero.primaryCta.label}
          </a>
          <a
            href={site.hero.secondaryCta.href}
            target="_blank"
            rel="noreferrer"
            className="btn btn-secondary"
          >
            {site.hero.secondaryCta.label}
            <ArrowUpRight size={16} strokeWidth={1.75} aria-hidden="true" />
          </a>
        </div>
        <p className="mt-8 text-sm text-[var(--page-muted)]">
          向下了解白球如何把目标推进到结果
        </p>
      </div>

      <div className="relative">
        <BaiqiuMascot />
      </div>
    </section>
  );
}
