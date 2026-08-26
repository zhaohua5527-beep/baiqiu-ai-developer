"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type MotionContextValue = {
  reduceMotion: boolean;
  ready: boolean;
};

const MotionContext = createContext<MotionContextValue>({
  reduceMotion: false,
  ready: false,
});

export function useMotionPrefs() {
  return useContext(MotionContext);
}

export function MotionProvider({ children }: { children: ReactNode }) {
  const [reduceMotion, setReduceMotion] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(media.matches);
    sync();
    media.addEventListener("change", sync);
    const timer = window.setTimeout(() => setReady(true), 50);
    return () => {
      media.removeEventListener("change", sync);
      window.clearTimeout(timer);
    };
  }, []);

  const value = useMemo(
    () => ({ reduceMotion, ready }),
    [reduceMotion, ready],
  );

  return (
    <MotionContext.Provider value={value}>{children}</MotionContext.Provider>
  );
}
