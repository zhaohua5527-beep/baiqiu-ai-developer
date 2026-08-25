"use client";

import { Monitor, Workflow, Settings2 } from "lucide-react";
import { site } from "@/content/site";

const icons = [Monitor, Workflow, Settings2];

export function DesktopAssistant() {
  return (
    <section className="section" aria-labelledby="desktop-title">
      <div className="container">
        <div className="surface-dark overflow-hidden p-6 md:p-10">
          <div className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-end">
            <div>
              <h2 id="desktop-title" className="display-sm text-[var(--bq-pearl)]">
                {site.desktop.title}
              </h2>
              <p className="mt-5 max-w-xl text-[1.02rem] leading-relaxed text-[var(--bq-mist)]">
                {site.desktop.body}
              </p>
            </div>
            <div className="grid gap-3">
              {site.desktop.points.map((point, index) => {
                const Icon = icons[index] || Monitor;
                return (
                  <div
                    key={point.title}
                    className="rounded-[16px] border border-[color-mix(in_srgb,var(--bq-line)_85%,var(--bq-ice)_15%)] bg-[color-mix(in_srgb,var(--bq-panel)_86%,transparent)] p-4"
                  >
                    <div className="flex items-start gap-3">
                      <span className="grid h-9 w-9 place-items-center rounded-full border border-[color-mix(in_srgb,var(--bq-ice)_30%,transparent)] text-[var(--bq-ice)]">
                        <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
                      </span>
                      <div>
                        <h3 className="font-semibold text-[var(--bq-pearl)]">
                          {point.title}
                        </h3>
                        <p className="mt-1 text-sm leading-relaxed text-[var(--bq-mist)]">
                          {point.body}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
