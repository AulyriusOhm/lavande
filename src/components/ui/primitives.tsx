import { cn, initials } from "@/lib/utils";
import { TONES } from "@/lib/mail";

export function Avatar({
  name,
  tone = 0,
  size = 44,
  className,
  rounded = "rounded-2xl",
}: {
  name: string;
  tone?: number;
  size?: number;
  className?: string;
  rounded?: string;
}) {
  return (
    <div
      className={cn(
        "grid shrink-0 place-items-center bg-gradient-to-br font-bold tracking-tight select-none",
        TONES[tone % TONES.length],
        rounded,
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.34) }}
    >
      {initials(name)}
    </div>
  );
}

export function IconButton({
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "focus-ring grid size-11 min-h-11 min-w-11 place-items-center rounded-full text-ink-soft transition-colors",
        "hover:bg-surface-2 hover:text-ink active:scale-95",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Chip({
  children,
  active,
  onClick,
  className,
}: {
  children: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "focus-ring inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-semibold transition-all",
        active
          ? "bg-accent text-accent-contrast shadow-[0_6px_16px_-8px_var(--accent)]"
          : "border border-line bg-surface text-ink-soft hover:border-accent-ring hover:text-ink",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function SwitchTrack({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative block h-6.5 w-11 shrink-0 rounded-full transition-colors duration-300",
        checked ? "bg-accent" : "bg-line",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 size-5.5 rounded-full bg-white shadow-sm transition-transform duration-300 ease-out",
          checked && "translate-x-[18px]",
        )}
      />
    </span>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="focus-ring grid size-11 shrink-0 place-items-center rounded-full"
    >
      <SwitchTrack checked={checked} />
    </button>
  );
}

export function ToggleRow({
  icon,
  label,
  hint,
  checked,
  onChange,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="focus-row flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-surface-2/70"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-soft">
        {icon}
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block text-[12.5px] font-bold text-ink">{label}</span>
        <span className="block text-[10.5px] font-medium text-ink-muted">{hint}</span>
      </span>
      <SwitchTrack checked={checked} />
    </button>
  );
}

export function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between px-5 pt-6 pb-2.5">
      <h2 className="text-[11px] font-bold tracking-[0.16em] text-ink-soft uppercase">{children}</h2>
      {hint ? <span className="text-[11px] text-ink-muted">{hint}</span> : null}
    </div>
  );
}

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-3xl border border-line bg-surface shadow-[0_1px_2px_rgba(30,20,50,0.03)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
