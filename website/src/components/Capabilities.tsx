"use client";

import {
  MessageSquare,
  FolderOpen,
  Wrench,
  Route,
  Table2,
  Puzzle,
} from "lucide-react";
import type { Feature } from "@/content/features";
import { features } from "@/content/features";

const icons = {
  chat: MessageSquare,
  files: FolderOpen,
  tools: Wrench,
  plan: Route,
  sheet: Table2,
  skills: Puzzle,
} as const;

function FeatureVisual({ visual }: { visual: Feature["visual"] }) {
  if (visual === "chat") {
    return (
      <div className="feature-visual space-y-2">
        <div className="ml-auto max-w-[78%] rounded-2xl bg-[color-mix(in_srgb,var(--bq-user)_88%,var(--bq-ice)_12%)] px-3 py-2 text-sm text-[var(--bq-pearl)]">
          帮我整理这些资料，并生成一份清晰的总结。
        </div>
        <div className="max-w-[86%] rounded-2xl bg-[color-mix(in_srgb,var(--bq-panel)_92%,black_8%)] px-3 py-2 text-sm text-[var(--bq-pearl)]">
          已理解目标：读取资料 → 提炼结构 → 输出总结文件。
        </div>
      </div>
    );
  }

  if (visual === "files") {
    return (
      <div className="feature-visual grid grid-cols-3 gap-2">
        {["报告.md", "纪要.txt", "归档/"].map((name) => (
          <div
            key={name}
            className="rounded-[12px] border border-[var(--page-line)] bg-white/70 px-2 py-3 text-center text-xs text-[var(--page-muted)]"
          >
            {name}
          </div>
        ))}
      </div>
    );
  }

  if (visual === "tools") {
    return (
      <div className="feature-visual flex flex-wrap gap-2">
        {["write_text_file", "write_xlsx", "web_search", "open_path"].map(
          (tool) => (
            <span
              key={tool}
              className="mono rounded-full border border-[color-mix(in_srgb,var(--bq-ice)_30%,transparent)] bg-[color-mix(in_srgb,var(--bq-ice)_10%,transparent)] px-2.5 py-1 text-[11px] text-[#35506c]"
            >
              {tool}
            </span>
          ),
        )}
      </div>
    );
  }

  if (visual === "plan") {
    return (
      <div className="feature-visual space-y-2">
        {["理解", "规划", "执行", "验证"].map((label, index) => (
          <div key={label} className="flex items-center gap-2 text-sm">
            <span
              className="h-2 w-2 rounded-full"
              style={{
                background:
                  index < 3 ? "var(--bq-signal)" : "color-mix(in srgb, var(--bq-ice) 55%, white)",
              }}
            />
            <span className="text-[var(--page-muted)]">{label}</span>
            <span className="ml-auto mono text-[11px] text-[var(--page-muted)]">
              {index < 3 ? "done" : "running"}
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (visual === "sheet") {
    return (
      <div className="feature-visual overflow-hidden">
        <div className="grid grid-cols-3 gap-px rounded-[10px] bg-[var(--page-line)] text-center text-[11px]">
          {["项目", "状态", "结论"].map((h) => (
            <div key={h} className="bg-white/80 px-2 py-2 font-medium">
              {h}
            </div>
          ))}
          {["A", "完成", "可发布", "B", "进行中", "需补充"].map((cell) => (
            <div key={cell} className="bg-white/70 px-2 py-2 text-[var(--page-muted)]">
              {cell}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="feature-visual flex items-center justify-between gap-3">
      <div>
        <p className="text-sm font-medium">Skills</p>
        <p className="mt-1 text-xs text-[var(--page-muted)]">
          安装 · 优化 · 回滚
        </p>
      </div>
      <div className="mono rounded-full bg-[#101822] px-3 py-1 text-[11px] text-[var(--bq-pearl)]">
        enabled
      </div>
    </div>
  );
}

export function CapabilityFeature({ feature }: { feature: Feature }) {
  const Icon = icons[feature.visual];
  return (
    <article
      className="bento-item surface has-orbit"
      data-span={feature.span || "normal"}
    >
      <span className="orbit-ring" aria-hidden="true" />
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold tracking-tight">{feature.title}</h3>
          <p className="mt-2 text-[0.95rem] leading-relaxed text-[var(--page-muted)]">
            {feature.body}
          </p>
        </div>
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-[var(--page-line)] bg-white/70 text-[#35506c]">
          <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
        </span>
      </div>
      <FeatureVisual visual={feature.visual} />
    </article>
  );
}

export function Capabilities() {
  return (
    <section
      id="capabilities"
      className="section container"
      aria-labelledby="capabilities-title"
    >
      <div className="mb-10 max-w-2xl">
        <h2 id="capabilities-title" className="display-sm">
          真实能力，来自已实现的桌面执行路径
        </h2>
        <p className="lede mt-4">
          下列能力均对应仓库中的产品层与工具实现，用普通人能懂的方式说明白球会做什么。
        </p>
      </div>
      <div className="bento">
        {features.map((feature) => (
          <CapabilityFeature key={feature.id} feature={feature} />
        ))}
      </div>
    </section>
  );
}
