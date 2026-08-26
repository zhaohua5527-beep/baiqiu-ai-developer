"use client";

import { useCases } from "@/content/features";

export function UseCases() {
  return (
    <section
      id="usecases"
      className="section container"
      aria-labelledby="usecases-title"
    >
      <div className="mb-8 max-w-2xl">
        <h2 id="usecases-title" className="display-sm">
          日常场景里，白球能帮你推进什么
        </h2>
        <p className="lede mt-4">
          面向普通个人用户的具体任务。横向浏览场景卡片，每张都对应可直接描述给白球的目标。
        </p>
      </div>

      <div className="usecase-rail" tabIndex={0} aria-label="使用场景列表">
        {useCases.map((item) => (
          <article key={item.id} className="usecase-card surface has-orbit">
            <span className="orbit-ring" aria-hidden="true" />
            <h3 className="text-xl font-semibold tracking-tight">{item.title}</h3>
            <p className="mt-3 text-[0.98rem] leading-relaxed text-[var(--page-muted)]">
              {item.body}
            </p>
            <p className="mt-6 rounded-[12px] border border-[var(--page-line)] bg-white/70 px-3 py-2 text-sm text-[#35506c]">
              “{item.prompt}”
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
