"use client";

import dynamic from "next/dynamic";
import { site } from "@/content/site";

const BaiqiuMascot = dynamic(
  () => import("@/components/BaiqiuMascot").then((mod) => mod.BaiqiuMascot),
  { ssr: false },
);

export function FinalCTA() {
  return (
    <section className="section container" aria-labelledby="final-title">
      <div className="relative overflow-hidden rounded-[28px] border border-[color-mix(in_srgb,var(--bq-light-line)_85%,var(--bq-ice)_15%)] bg-[linear-gradient(180deg,#fbfcfe_0%,#eef4fb_100%)] px-6 py-12 text-center md:px-10">
        <div className="mx-auto mb-6 w-full max-w-[280px]">
          <BaiqiuMascot interactive={false} />
        </div>
        <h2 id="final-title" className="display-sm mx-auto max-w-3xl">
          {site.brandClose.headline}
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-[var(--page-muted)] leading-relaxed">
          {site.brandClose.body}
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <a href={site.finalCta.primary.href} className="btn btn-primary has-orbit">
            <span className="orbit-ring" aria-hidden="true" />
            {site.finalCta.primary.label}
          </a>
          <a
            href={site.finalCta.secondary.href}
            target="_blank"
            rel="noreferrer"
            className="btn btn-secondary"
          >
            {site.finalCta.secondary.label}
          </a>
        </div>
        {!site.downloadUrl ? (
          <p className="mt-5 text-sm text-[var(--page-muted)]">
            {site.finalCta.downloadLabel}
          </p>
        ) : null}
      </div>
    </section>
  );
}
