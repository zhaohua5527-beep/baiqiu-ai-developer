"use client";

import { useEffect, useState } from "react";
import { useMotionPrefs } from "@/components/MotionProvider";

export function PageLoader() {
  const [visible, setVisible] = useState(true);
  const { reduceMotion } = useMotionPrefs();

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setVisible(false),
      reduceMotion ? 120 : 750,
    );
    return () => window.clearTimeout(timeout);
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
