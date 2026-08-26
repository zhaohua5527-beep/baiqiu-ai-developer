"use client";

import { useEffect, useState } from "react";
import { workflowDemo } from "@/content/features";
import { useMotionPrefs } from "@/components/MotionProvider";

export function WorkflowDemo() {
  const [active, setActive] = useState(0);
  const { reduceMotion } = useMotionPrefs();

  useEffect(() => {
    if (reduceMotion) return;
    const timer = window.setInterval(() => {
      setActive((value) => (value + 1) % workflowDemo.stages.length);
    }, 2600);
    return () => window.clearInterval(timer);
  }, [reduceMotion]);

  const stage = workflowDemo.stages[active];

  return (
    <section className="section container" aria-labelledby="workflow-title">
      <div className="mb-10 max-w-2xl">
        <h2 id="workflow-title" className="display-sm">
          一次真实任务如何被推进
        </h2>
        <p className="lede mt-4">
          示例任务来自产品空状态提示的工作方式：整理资料，并生成清晰总结。
        </p>
      </div>

      <div className="surface-dark workflow-shell p-4 md:p-5">
        <div className="space-y-2">
          <p className="px-2 text-sm text-[var(--bq-mist)]">任务</p>
          <p className="px-2 text-lg font-medium text-[var(--bq-pearl)]">
            {workflowDemo.task}
          </p>
          <div className="mt-4 space-y-1">
            {workflowDemo.stages.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className="workflow-stage"
                data-active={active === index}
                onClick={() => setActive(index)}
              >
                <span className="mono grid h-7 w-7 place-items-center rounded-full border border-[color-mix(in_srgb,var(--bq-line)_80%,var(--bq-ice)_20%)] text-[11px]">
                  {index + 1}
                </span>
                <span>
                  <span className="block text-sm font-medium text-[var(--bq-pearl)]">
                    {item.label}
                  </span>
                  <span className="block text-xs text-[var(--bq-mist)]">
                    {item.detail}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-[18px] border border-[color-mix(in_srgb,var(--bq-line)_85%,var(--bq-ice)_15%)] bg-[color-mix(in_srgb,var(--bq-panel)_90%,black_10%)] p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-[var(--bq-mist)]">执行舞台</p>
            <span className="mono rounded-full border border-[color-mix(in_srgb,var(--bq-ice)_35%,transparent)] px-2.5 py-1 text-[11px] text-[var(--bq-ice)]">
              {stage.label}
            </span>
          </div>
          <h3 className="mt-6 text-2xl font-semibold tracking-tight text-[var(--bq-pearl)]">
            {stage.label}
          </h3>
          <p className="mt-3 max-w-md text-[0.98rem] leading-relaxed text-[var(--bq-mist)]">
            {stage.detail}
          </p>
          <div className="mt-8 grid gap-2">
            {workflowDemo.stages.map((item, index) => (
              <div
                key={item.id}
                className="flex items-center gap-3 rounded-[12px] border border-[color-mix(in_srgb,var(--bq-line)_70%,transparent)] px-3 py-2"
                style={{
                  opacity: index <= active ? 1 : 0.35,
                }}
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{
                    background:
                      index < active
                        ? "var(--bq-signal)"
                        : index === active
                          ? "var(--bq-ice)"
                          : "var(--bq-line)",
                  }}
                />
                <span className="text-sm text-[var(--bq-pearl)]">{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
