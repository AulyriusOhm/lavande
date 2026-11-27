import { cn } from "@/lib/utils";

export function Surface({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("rounded-[26px] border border-line bg-surface", className)}>{children}</div>;
}

export function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <h2 className={cn("text-[10.5px] font-bold tracking-[0.16em] text-ink-muted uppercase", className)}>
      {children}
    </h2>
  );
}

export function PaneTitle({ children, hint, small = false }: { children: React.ReactNode; hint?: React.ReactNode; small?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <h1
        className={cn(
          "leading-tight font-extrabold tracking-[-0.035em] text-ink",
          small ? "text-[15px]" : "text-[19px]",
        )}
      >
        {children}
      </h1>
      {hint ? <span className="text-[11.5px] font-semibold text-ink-muted">{hint}</span> : null}
    </div>
  );
}

const BUTTON_VARIANTS = {
  primary:
    "bg-accent text-accent-contrast shadow-[0_10px_26px_-14px_var(--accent)] hover:brightness-[1.04]",
  soft: "bg-accent-soft text-accent-ink hover:bg-accent-ring/40",
  ghost: "border border-line bg-surface text-ink-soft hover:bg-surface-2 hover:text-ink",
  plain: "text-ink-soft hover:bg-surface-2 hover:text-ink",
  danger:
    "border border-rose-300 bg-surface text-rose-700 hover:bg-rose-500/10 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300 dark:hover:bg-rose-500/15",
} as const;

const BUTTON_SIZES = {
  sm: "h-8 gap-1.5 rounded-lg px-2.5 text-[11.5px]",
  md: "h-10 gap-2 rounded-xl px-3.5 text-[12.5px]",
  lg: "h-11 gap-2 rounded-full px-5 text-[13px]",
} as const;

export function DButton({
  variant = "ghost",
  size = "md",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: keyof typeof BUTTON_SIZES;
}) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "focus-ring inline-flex shrink-0 items-center justify-center font-bold whitespace-nowrap transition-colors duration-200 disabled:pointer-events-none disabled:opacity-45",
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
    />
  );
}

export function DIconButton({
  label,
  active,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={cn(
        "focus-ring grid size-9 shrink-0 place-items-center rounded-full transition-colors duration-200",
        active ? "bg-accent-soft text-accent-ink" : "text-ink-soft hover:bg-surface-2 hover:text-ink",
        className,
      )}
    />
  );
}

export function DChip({
  active,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      aria-pressed={active}
      className={cn(
        "focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[11.5px] font-semibold transition-all duration-200",
        active
          ? "bg-accent text-accent-contrast shadow-[0_6px_16px_-9px_var(--accent)]"
          : "border border-line bg-surface text-ink-soft hover:border-accent-ring hover:text-ink",
        className,
      )}
    >
      {children}
    </button>
  );
}

const BADGE_TONES = {
  accent: "bg-accent-soft text-accent-ink",
  neutral: "bg-surface-2 text-ink-muted",
  green: "bg-emerald-500/12 text-emerald-800 dark:text-emerald-300",
  amber: "bg-amber-500/14 text-amber-800 dark:text-amber-300",
  sky: "bg-sky-500/12 text-sky-800 dark:text-sky-300",
  rose: "bg-rose-500/12 text-rose-700 dark:text-rose-300",
} as const;

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: keyof typeof BADGE_TONES;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold",
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function TextInput({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        "focus-ring h-10 w-full rounded-xl border border-line bg-surface px-3 text-[12.5px] font-medium text-ink",
        "placeholder:font-medium placeholder:text-ink-muted",
        className,
      )}
    />
  );
}

export function TextArea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cn(
        "focus-ring w-full resize-none rounded-xl border border-line bg-surface px-3 py-2.5 text-[12.5px] leading-relaxed font-medium text-ink",
        "placeholder:font-medium placeholder:text-ink-muted",
        className,
      )}
    />
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-md border border-line bg-surface px-1.5 py-0.5 font-sans text-[10px] font-bold text-ink-muted">
      {children}
    </kbd>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  className,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex h-full flex-col items-center justify-center gap-3 px-8 text-center", className)}>
      <div className="grid size-12 place-items-center rounded-2xl bg-surface-2 text-ink-muted">{icon}</div>
      <div className="space-y-1">
        <p className="text-[13px] font-bold text-ink">{title}</p>
        {hint ? <p className="max-w-[34ch] text-[11.5px] font-medium text-ink-muted">{hint}</p> : null}
      </div>
    </div>
  );
}
