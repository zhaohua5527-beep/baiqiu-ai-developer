"use client";

import type { ReactNode } from "react";
import { useMotionPrefs } from "@/components/MotionProvider";

export function ReducedMotionFallback({
  animated,
  staticFallback,
}: {
  animated: ReactNode;
  staticFallback: ReactNode;
}) {
  const { reduceMotion } = useMotionPrefs();
  return <>{reduceMotion ? staticFallback : animated}</>;
}
