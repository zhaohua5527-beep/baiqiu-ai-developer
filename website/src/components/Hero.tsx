"use client";

import {
  ArrowRight,
  Download,
  MonitorSmartphone,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { site } from "@/content/site";

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

          <div className="hero-actions">
            <a href={site.downloadUrl ?? "#download"} className="hero-download-cta">
              <Download size={18} aria-hidden="true" />
              <span>下载 Windows 客户端</span>
            </a>
            <a href={site.hero.primaryCta.href} className="hero-secondary-cta">
              <span>{site.hero.primaryCta.label}</span>
              <ArrowRight size={16} aria-hidden="true" />
            </a>
          </div>

          <div className="hero-trust-rail" aria-label="安装说明">
            <span><Sparkles size={14} aria-hidden="true" /> 白色安装页</span>
            <span><ShieldCheck size={14} aria-hidden="true" /> 自动创建桌面图标</span>
            <span><MonitorSmartphone size={14} aria-hidden="true" /> 适合零基础用户</span>
          </div>
        </div>

        <div className="hero-side">
          <div className="hero-visual-panel bezel">
            <div className="bezel-core hero-visual-panel__core">
              <div className="hero-visual-panel__meta">
                <span className="hero-visual-panel__eyebrow">桌面图标预览</span>
                <strong>白球 AI 安装器</strong>
                <p>白色、高级感、安装完成后自动生成快捷方式。</p>
              </div>
              <div className="hero-app-icon-wrap" aria-hidden="true">
                <img src="/brand/icon-256.png" alt="" className="hero-app-icon" />
              </div>
            </div>
          </div>

          <aside className="hero-download-panel" id="download">
            <div className="hero-download-panel__head">
              <span className="hero-download-panel__kicker">下载</span>
              <strong>Windows 客户端</strong>
              <p>下载后双击即可安装，系统会自动创建桌面图标和开始菜单快捷方式。</p>
            </div>
            <dl className="hero-download-meta">
              <div>
                <dt>当前版本</dt>
                <dd>{site.version}</dd>
              </div>
              <div>
                <dt>支持系统</dt>
                <dd>{site.platform}</dd>
              </div>
              <div>
                <dt>安装方式</dt>
                <dd>一键完成</dd>
              </div>
            </dl>
            <a href={site.downloadUrl ?? "#download"} className="hero-download-btn">
              <Download size={17} aria-hidden="true" />
              <span>立即下载</span>
            </a>
            <div className="hero-download-note">
              <span>白色</span>
              <span>高级感</span>
              <span>零基础可装</span>
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}
