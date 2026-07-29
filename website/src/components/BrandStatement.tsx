"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { site } from "@/content/site";
import { journeySteps } from "@/content/features";
import { useMotionPrefs } from "@/components/MotionProvider";

gsap.registerPlugin(ScrollTrigger);

export function BrandStatement() {
  const ref = useRef<HTMLElement>(null);
  const { reduceMotion } = useMotionPrefs();

  useEffect(() => {
    if (reduceMotion || !ref.current) return;
    const ctx = gsap.context(() => {
      gsap.from("[data-brand-line]", {
        y: 28,
        opacity: 0,
        duration: 0.8,
        ease: "power3.out",
        stagger: 0.08,
        scrollTrigger: {
          trigger: ref.current,
          start: "top 75%",
        },
      });
    }, ref);
    return () => ctx.revert();
  }, [reduceMotion]);

  return (
    <section ref={ref} className="section container" aria-labelledby="brand-title">
      <p className="eyebrow" data-brand-line>
        核心主张
      </p>
      <h2 id="brand-title" className="display-sm mt-4 max-w-4xl" data-brand-line>
        {site.brandStatement.headline}
      </h2>
      <p className="lede mt-5" data-brand-line>
        {site.brandStatement.body}
      </p>
    </section>
  );
}

export function TaskJourney() {
  const ref = useRef<HTMLElement>(null);
  const [active, setActive] = useState(0);
  const { reduceMotion } = useMotionPrefs();

  useEffect(() => {
    if (!ref.current) return;
    if (reduceMotion) return;

    const ctx = gsap.context(() => {
      const nodes = gsap.utils.toArray<HTMLElement>("[data-journey-node]");
      nodes.forEach((node, index) => {
        ScrollTrigger.create({
          trigger: node,
          start: "top 70%",
          end: "bottom 45%",
          onEnter: () => setActive(index),
          onEnterBack: () => setActive(index),
        });
        gsap.from(node, {
          x: 24,
          opacity: 0,
          duration: 0.7,
          ease: "power3.out",
          scrollTrigger: {
            trigger: node,
            start: "top 80%",
          },
        });
      });
    }, ref);

    return () => ctx.revert();
  }, [reduceMotion]);

  return (
    <section
      ref={ref}
      className="section-tight container"
      aria-labelledby="journey-title"
    >
      <div className="mb-10 max-w-2xl">
        <h2 id="journey-title" className="display-sm">
          从目标到结果的任务轨道
        </h2>
        <p className="lede mt-4">
          白球把一次请求推进成可观察的执行过程：理解、拆解、行动、交付。
        </p>
      </div>

      <div className="journey-track max-w-3xl">
        <div className="journey-line" aria-hidden="true" />
        {journeySteps.map((step, index) => (
          <article
            key={step.id}
            data-journey-node
            data-active={active >= index}
            className="journey-node"
          >
            <div className="journey-dot mono text-xs">{index + 1}</div>
            <div className="surface p-5">
              <p className="text-sm text-[var(--page-muted)]">{step.label}</p>
              <h3 className="mt-1 text-xl font-semibold tracking-tight">
                {step.title}
              </h3>
              <p className="mt-2 text-[0.98rem] leading-relaxed text-[var(--page-muted)]">
                {step.body}
              </p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
