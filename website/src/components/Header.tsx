"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { site } from "@/content/site";

export function Header() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState("");

  useEffect(() => {
    const ids = site.nav.map((item) => item.href.slice(1));
    const sections = ids
      .map((id) => document.getElementById(id))
      .filter((section): section is HTMLElement => Boolean(section));
    if (!sections.length || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) setActive(`#${visible.target.id}`);
      },
      { rootMargin: "-20% 0px -62%", threshold: [0.1, 0.35, 0.7] },
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      <header className="site-header nav-layer">
        <div className="floating-nav bezel">
          <div className="bezel-core floating-nav__core flex min-h-16 items-center justify-between gap-5 px-4 py-2">
            <Link href="/" className="shrink-0" aria-label="白球 AI 首页">
              <BrandMark />
            </Link>
            <nav className="hidden items-center gap-6 lg:flex" aria-label="主导航">
              {site.nav.map((item) => (
                <a key={item.href} href={item.href} className="nav-link" data-active={active === item.href}>
                  {item.label}
                </a>
              ))}
            </nav>
            <a href="#journey" className="island-cta hidden lg:inline-flex">
              <span>开始探索</span>
              <span className="island-cta__icon" aria-hidden="true">↘</span>
            </a>
            <button
              type="button"
              className="icon-btn inline-flex h-11 w-11 flex-col items-center justify-center gap-1.5 rounded-full border border-[var(--page-line)] bg-white/70 lg:hidden"
              aria-label={open ? "关闭菜单" : "打开菜单"}
              aria-expanded={open}
              aria-controls="mobile-menu"
              onClick={() => setOpen((value) => !value)}
            >
              <span className="menu-line block h-px w-4 bg-current transition-transform" data-open={open} style={open ? { transform: "translateY(4px) rotate(45deg)" } : undefined} />
              <span className="menu-line block h-px w-4 bg-current transition-transform" data-open={open} style={open ? { transform: "translateY(-3px) rotate(-45deg)" } : undefined} />
            </button>
          </div>
        </div>
      </header>

      <div id="mobile-menu" className="mobile-panel lg:hidden" data-open={open} aria-hidden={!open}>
        <nav className="container flex flex-col gap-2" aria-label="移动导航">
          {site.nav.map((item, index) => (
            <a
              key={item.href}
              href={item.href}
              className="flex items-center justify-between rounded-[14px] px-3 py-3 text-[1rem] text-[var(--page-fg)] transition-all"
              style={{ transitionDelay: `${index * 70 + 100}ms` }}
              tabIndex={open ? 0 : -1}
              onClick={() => setOpen(false)}
            >
              <span>{item.label}</span><span aria-hidden="true">↘</span>
            </a>
          ))}
          <a
            href="#journey"
            className="island-cta mt-2 self-start"
            style={{ transitionDelay: `${site.nav.length * 70 + 100}ms` }}
            tabIndex={open ? 0 : -1}
            onClick={() => setOpen(false)}
          >
            <span>开始探索</span><span className="island-cta__icon" aria-hidden="true">↘</span>
          </a>
        </nav>
      </div>
    </>
  );
}

export function MobileNavigation() {
  return null;
}
