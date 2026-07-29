"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { BrandMark } from "@/components/BrandMark";
import { site } from "@/content/site";
import { cn } from "@/lib/cn";

export function Header() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState("");

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 12);
      const sections = site.nav
        .map((item) => item.href.replace("#", ""))
        .concat(["faq", "product", "capabilities", "usecases"]);
      let current = "";
      for (const id of sections) {
        const el = document.getElementById(id);
        if (!el) continue;
        const top = el.getBoundingClientRect().top;
        if (top < 120) current = id;
      }
      setActive(current ? `#${current}` : "");
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <header className={cn("site-header", scrolled && "is-scrolled")}>
        <div className="container flex h-full items-center justify-between gap-4">
          <Link href="/" className="shrink-0" aria-label="白球 AI 首页">
            <BrandMark />
          </Link>

          <nav className="hidden items-center gap-6 lg:flex" aria-label="主导航">
            {site.nav.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="nav-link"
                data-active={active === item.href}
              >
                {item.label}
              </a>
            ))}
            <a
              href={site.githubUrl}
              target="_blank"
              rel="noreferrer"
              className="nav-link inline-flex items-center gap-1.5"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.52 2.87 8.35 6.84 9.7.5.1.68-.22.68-.48 0-.24-.01-.87-.01-1.7-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.89 1.57 2.34 1.12 2.91.86.09-.66.35-1.12.63-1.37-2.22-.26-4.55-1.14-4.55-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.31.1-2.73 0 0 .84-.27 2.75 1.05A9.3 9.3 0 0 1 12 7.5c.85 0 1.71.12 2.51.35 1.9-1.32 2.74-1.05 2.74-1.05.55 1.42.2 2.47.1 2.73.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .26.18.59.69.48A10.03 10.03 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z" />
              </svg>
              GitHub
            </a>
            <a href="#capabilities" className="btn btn-primary has-orbit text-sm">
              <span className="orbit-ring" aria-hidden="true" />
              认识白球 AI
            </a>
          </nav>

          <button
            type="button"
            className="icon-btn inline-flex h-10 w-10 items-center justify-center rounded-full border border-[var(--page-line)] bg-white/70 lg:hidden"
            aria-label={open ? "关闭菜单" : "打开菜单"}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </header>

      {open ? (
        <div className="mobile-panel lg:hidden">
          <nav className="container flex flex-col gap-2" aria-label="移动导航">
            {site.nav.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="rounded-[14px] px-3 py-3 text-[1rem] text-[var(--page-fg)]"
                onClick={() => setOpen(false)}
              >
                {item.label}
              </a>
            ))}
            <a
              href={site.githubUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-[14px] px-3 py-3"
              onClick={() => setOpen(false)}
            >
              GitHub
            </a>
            <a
              href="#capabilities"
              className="btn btn-primary mt-2"
              onClick={() => setOpen(false)}
            >
              认识白球 AI
            </a>
          </nav>
        </div>
      ) : null}
    </>
  );
}

export function MobileNavigation() {
  return null;
}
