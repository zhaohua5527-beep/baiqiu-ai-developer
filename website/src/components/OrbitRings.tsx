"use client";

import { useEffect, useRef } from "react";

type OrbitRingsProps = {
  className?: string;
  animated?: boolean;
};

export function OrbitRings({ className, animated = true }: OrbitRingsProps) {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!animated || !ref.current) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;

    let frame = 0;
    let raf = 0;
    const dots = Array.from(ref.current.querySelectorAll<SVGCircleElement>("[data-orbit-dot]"));
    const tick = () => {
      frame += 1;
      dots.forEach((dot, index) => {
        const speed = 0.008 + index * 0.003;
        const angle = frame * speed + index * 1.7;
        const cx = Number(dot.dataset.cx);
        const cy = Number(dot.dataset.cy);
        const r = Number(dot.dataset.r);
        dot.setAttribute("cx", String(cx + Math.cos(angle) * r));
        dot.setAttribute("cy", String(cy + Math.sin(angle) * r));
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const onVisibility = () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else raf = requestAnimationFrame(tick);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [animated]);

  return (
    <svg
      ref={ref}
      className={["orbit-svg", className].filter(Boolean).join(" ")}
      viewBox="0 0 400 400"
      aria-hidden="true"
    >
      <ellipse className="ring ring-soft" cx="200" cy="200" rx="168" ry="108" transform="rotate(-18 200 200)" />
      <ellipse className="ring" cx="200" cy="200" rx="148" ry="92" transform="rotate(24 200 200)" />
      <ellipse className="ring ring-soft" cx="200" cy="200" rx="118" ry="118" />
      <circle
        className="dot"
        data-orbit-dot
        data-cx="200"
        data-cy="200"
        data-r="148"
        r="3.2"
        cx="348"
        cy="200"
      />
      <circle
        className="dot"
        data-orbit-dot
        data-cx="200"
        data-cy="200"
        data-r="118"
        r="2.4"
        cx="200"
        cy="82"
      />
    </svg>
  );
}
