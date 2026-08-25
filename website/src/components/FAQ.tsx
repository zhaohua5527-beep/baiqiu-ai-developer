"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { faqItems } from "@/content/faq";
import { cn } from "@/lib/cn";

export function FAQ() {
  const baseId = useId();
  const [openId, setOpenId] = useState<string | null>(faqItems[0]?.id ?? null);

  return (
    <section id="faq" className="section container" aria-labelledby="faq-title">
      <div className="mb-8 max-w-2xl">
        <h2 id="faq-title" className="display-sm">
          常见问题
        </h2>
        <p className="lede mt-4">答案依据当前仓库中的产品实现与平台定位整理。</p>
      </div>

      <div className="mx-auto max-w-3xl">
        {faqItems.map((item) => {
          const isOpen = openId === item.id;
          const panelId = `${baseId}-${item.id}-panel`;
          const buttonId = `${baseId}-${item.id}-button`;
          return (
            <div key={item.id} className="faq-item">
              <h3>
                <button
                  id={buttonId}
                  type="button"
                  className="faq-trigger"
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  onClick={() => setOpenId(isOpen ? null : item.id)}
                >
                  <span className="text-lg font-medium tracking-tight">
                    {item.question}
                  </span>
                  <ChevronDown
                    size={18}
                    className={cn(
                      "shrink-0 text-[var(--page-muted)] transition-transform duration-200",
                      isOpen && "rotate-180",
                    )}
                    aria-hidden="true"
                  />
                </button>
              </h3>
              <div
                id={panelId}
                role="region"
                aria-labelledby={buttonId}
                className="faq-panel"
                data-open={isOpen}
              >
                <div className="faq-panel-inner">
                  <p className="pb-5 pr-8 text-[0.98rem] leading-relaxed text-[var(--page-muted)]">
                    {item.answer}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
