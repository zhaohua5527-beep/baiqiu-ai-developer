import { cn } from "@/lib/cn";

type BrandMarkProps = {
  className?: string;
  showWordmark?: boolean;
  size?: number;
};

export function BrandMark({
  className,
  showWordmark = true,
  size = 28,
}: BrandMarkProps) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <span
        aria-hidden="true"
        className="brand-mark__symbol relative grid place-items-center overflow-hidden rounded-[28%] bg-white shadow-[0_8px_24px_rgba(15,23,42,0.12)]"
        style={{ width: size, height: size }}
      >
        <img
          src="/brand/icon-256.png"
          alt=""
          width={size}
          height={size}
          className="h-full w-full object-contain"
        />
      </span>
      {showWordmark ? (
        <span className="brand-mark__wordmark text-[0.98rem] font-semibold tracking-tight text-[var(--page-fg)]">
          白球 AI
        </span>
      ) : null}
    </span>
  );
}
