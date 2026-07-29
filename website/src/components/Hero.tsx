"use client";

import dynamic from "next/dynamic";
import { site } from "@/content/site";

const BaiqiuMascot = dynamic(
  () => import("@/components/BaiqiuMascot").then((mod) => mod.BaiqiuMascot),
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
    <section className="hero-cascade" aria-labelledby="hero-title">
      <div className="container hero-cascade__grid">
        <div className="hero-copy relative z-[2]">
          <p className="hero-kicker">白球 AI / Windows 助理</p>
          <h1 id="hero-title" className="display hero-title">
            <span>把想法交给白球。</span>
            <span>让结果回到你手上。</span>
          </h1>
          <p className="lede hero-subtitle">{site.hero.subtitle}</p>
          <a href={site.hero.primaryCta.href} className="island-cta hero-cta">
            <span>{site.hero.primaryCta.label}</span>
            <span className="island-cta__icon" aria-hidden="true">↘</span>
          </a>
        </div>

        <BaiqiuMascot className="hero-orb" />

        <div className="hero-product-peek bezel" aria-hidden="true">
          <div className="bezel-core hero-product-peek__core">
            <div className="hero-product-peek__topline">
              <span className="mono">白球 / EXECUTION WINDOW</span>
              <span className="hero-product-peek__status"><i /> RUNNING</span>
            </div>
            <div className="hero-product-peek__body">
              <span className="hero-product-peek__command">整理本周桌面资料</span>
              <span className="hero-product-peek__result">已找到 24 个相关文件</span>
            </div>
            <div className="hero-product-peek__rail"><span /><span /><span /></div>
          </div>
        </div>
      </div>
    </section>
  );
}
