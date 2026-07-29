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
        className="relative grid place-items-center overflow-hidden rounded-[22%] bg-white shadow-[0_8px_24px_rgba(15,23,42,0.12)]"
        style={{ width: size, height: size }}
      >
        <svg viewBox="0 0 64 64" width={size * 0.72} height={size * 0.72}>
          <defs>
            <linearGradient id="bq-w" x1="8" y1="10" x2="56" y2="54" gradientUnits="userSpaceOnUse">
              <stop stopColor="#4AA7FF" />
              <stop offset="0.55" stopColor="#1E6FE8" />
              <stop offset="1" stopColor="#0B3FAF" />
            </linearGradient>
          </defs>
          <path
            d="M12 18c4.2 0 7.4 2.1 10.2 8.4L28.5 42c1.4 3.2 2.6 4.8 3.8 4.8s2.4-1.6 3.8-4.8L42 26.4C44.8 20.1 48 18 52.2 18c1.7 0 3 .5 3.8 1.1-.9 1.4-2.1 2.2-3.5 2.2-1.9 0-3.5 1-5.5 5.4L38.4 42.2C35.8 48.1 33.4 51 32.3 51c-1.1 0-3.5-2.9-6.1-8.8L17.5 26.7c-2-4.4-3.6-5.4-5.5-5.4-1.4 0-2.6-.8-3.5-2.2.8-.6 2.1-1.1 3.5-1.1Z"
            fill="url(#bq-w)"
          />
          <ellipse
            cx="32"
            cy="32"
            rx="27"
            ry="27"
            fill="none"
            stroke="url(#bq-w)"
            strokeWidth="1.2"
            opacity="0.22"
          />
        </svg>
      </span>
      {showWordmark ? (
        <span className="text-[0.98rem] font-semibold tracking-tight text-[var(--page-fg)]">
          白球 AI
        </span>
      ) : null}
    </span>
  );
}
