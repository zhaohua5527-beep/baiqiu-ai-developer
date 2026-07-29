"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { productUi } from "@/content/features";
import { useMotionPrefs } from "@/components/MotionProvider";

gsap.registerPlugin(ScrollTrigger);

export function ProductShowcase() {
  const ref = useRef<HTMLElement>(null);
  const { reduceMotion } = useMotionPrefs();

  useEffect(() => {
    if (reduceMotion || !ref.current) return;
    const ctx = gsap.context(() => {
      gsap.from("[data-product-frame]", {
        y: 48,
        scale: 0.96,
        opacity: 0.4,
        ease: "none",
        scrollTrigger: {
          trigger: ref.current,
          start: "top 80%",
          end: "top 35%",
          scrub: 1,
        },
      });
    }, ref);
    return () => ctx.revert();
  }, [reduceMotion]);

  return (
    <section
      id="product"
      ref={ref}
      className="section container"
      aria-labelledby="product-title"
    >
      <div className="mb-10 max-w-2xl">
        <h2 id="product-title" className="display-sm">
          产品界面：会话、执行舞台与运行态势
        </h2>
        <p className="lede mt-4">
          界面结构复刻自现有 Electron 客户端：左侧工作记忆，中央执行舞台，右侧运行状态，底部 Orbit 输入区。
        </p>
      </div>

      <div data-product-frame className="product-frame">
        <div className="product-titlebar">
          <div>
            <p className="text-sm font-semibold text-[var(--bq-pearl)]">白球 AI</p>
            <p className="text-xs text-[var(--bq-mist)]">
              <span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-[var(--bq-signal)] align-middle" />
              内核就绪
            </p>
          </div>
          <div className="flex gap-2 text-xs text-[var(--bq-mist)]">
            <span className="rounded-full border border-[var(--bq-line)] px-2 py-1">模型</span>
            <span className="rounded-full border border-[var(--bq-line)] px-2 py-1">设置</span>
          </div>
        </div>

        <div className="product-body text-[var(--bq-pearl)]">
          <aside className="product-pane">
            <p className="mb-3 text-xs text-[var(--bq-mist)]">会话</p>
            <button
              type="button"
              className="mb-3 w-full rounded-[12px] border border-[color-mix(in_srgb,var(--bq-ice)_30%,transparent)] bg-[color-mix(in_srgb,var(--bq-ice)_10%,transparent)] px-3 py-2 text-left text-sm"
            >
              新对话
            </button>
            <div className="space-y-2">
              {productUi.sessions.map((session, index) => (
                <div
                  key={session}
                  className="rounded-[12px] border border-[var(--bq-line)] px-3 py-2 text-sm"
                  style={{
                    boxShadow:
                      index === 0
                        ? "0 0 0 1px color-mix(in srgb, var(--bq-ice) 28%, transparent)"
                        : undefined,
                  }}
                >
                  {session}
                </div>
              ))}
            </div>
          </aside>

          <div className="flex min-h-[380px] flex-col">
            <div className="flex flex-1 items-center justify-center p-6">
              <div className="max-w-md rounded-[18px] border border-[color-mix(in_srgb,var(--bq-line)_80%,var(--bq-ice)_20%)] bg-[color-mix(in_srgb,var(--bq-panel-soft)_88%,transparent)] p-6 text-center shadow-[var(--orbit-glow)]">
                <p className="mono text-[11px] tracking-[0.14em] text-[var(--bq-ice)]">
                  ORBIT READY
                </p>
                <h3 className="mt-3 text-2xl font-semibold">{productUi.emptyTitle}</h3>
                <p className="mt-3 text-sm leading-relaxed text-[var(--bq-mist)]">
                  {productUi.emptyBody}
                </p>
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  {productUi.tips.map((tip) => (
                    <span
                      key={tip}
                      className="rounded-full border border-[var(--bq-line)] px-3 py-1 text-xs text-[var(--bq-mist)]"
                    >
                      {tip}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <div className="product-composer">
              <span className="grid h-8 w-8 place-items-center rounded-full border border-[var(--bq-line)] text-[var(--bq-mist)]">
                +
              </span>
              <span className="flex-1 text-sm text-[var(--bq-mist)]">
                描述任务，例如：整理桌面文件 / 分析表格 / 生成本周计划
              </span>
              <span className="grid h-9 w-9 place-items-center rounded-full bg-[linear-gradient(180deg,#1a2430_0%,#0e141c_100%)] text-[var(--bq-pearl)] shadow-[var(--orbit-glow)]">
                ↑
              </span>
            </div>
          </div>

          <aside className="product-pane">
            <p className="mb-3 text-xs text-[var(--bq-mist)]">运行态势</p>
            <div className="space-y-3">
              {productUi.status.map((item) => (
                <div
                  key={item}
                  className="rounded-[12px] border border-[var(--bq-line)] bg-[color-mix(in_srgb,var(--bq-panel-soft)_70%,transparent)] px-3 py-3"
                >
                  <p className="text-sm">{item}</p>
                </div>
              ))}
              <div className="rounded-[12px] border border-[color-mix(in_srgb,var(--bq-signal)_35%,transparent)] px-3 py-3">
                <p className="text-xs text-[var(--bq-mist)]">任务看板</p>
                <p className="mt-1 text-sm text-[var(--bq-signal)]">待命 / 可展开</p>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}
