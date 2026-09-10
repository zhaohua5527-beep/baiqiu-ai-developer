"use client";

import { useEffect, useState } from "react";
import { useMotionPrefs } from "@/components/MotionProvider";

export function PageLoader() {
  const [visible, setVisible] = useState(true);
  const { reduceMotion } = useMotionPrefs();

  useEffect(() => {
    if ("scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }

    const resetScroll = () => window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    resetScroll();
    window.addEventListener("pageshow", resetScroll);

    const timeout = window.setTimeout(
      () => setVisible(false),
      reduceMotion ? 120 : 750,
    );
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("pageshow", resetScroll);
    };
  }, [reduceMotion]);

  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-[color-mix(in_srgb,var(--bq-light)_92%,white)]"
      aria-hidden="true"
    >
      <div className="loader-orbit" />
    </div>
  );
}
