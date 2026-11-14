import { Icon } from "@/components/icons";
import { useLightbox } from "@/components/ui/lightbox";

interface ThemeShotProps {
  name: string;
  alt: string;
  width: number;
  height: number;
  className?: string;
  wrapperClassName?: string;
  eager?: boolean;
}

export function ThemeShot({ name, alt, width, height, className, wrapperClassName, eager = false }: ThemeShotProps) {
  const { open } = useLightbox();
  const loading = eager ? "eager" : "lazy";
  const base = import.meta.env.BASE_URL;
  return (
    <button
      type="button"
      onClick={() => open(name)}
      aria-label={`Agrandir la capture : ${alt}`}
      className={`group/shot relative block cursor-zoom-in overflow-hidden ${wrapperClassName ?? ""}`}
    >
      <img
        src={`${base}shots/${name}-dark.webp`}
        alt={alt}
        width={width}
        height={height}
        loading={loading}
        decoding="async"
        className={`shot-dark ${className ?? ""}`}
      />
      <img
        src={`${base}shots/${name}-light.webp`}
        alt=""
        aria-hidden="true"
        width={width}
        height={height}
        loading={loading}
        decoding="async"
        className={`shot-light ${className ?? ""}`}
      />
      <span className="pointer-events-none absolute inset-0 flex items-end justify-end p-3 opacity-0 transition-opacity duration-300 group-hover/shot:opacity-100 group-focus-visible/shot:opacity-100">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface/90 px-3 py-1.5 text-[0.72rem] font-bold text-ink shadow-[var(--shadow-soft)] backdrop-blur">
          <Icon name="zoomIn" className="size-3.5 text-accent" />
          Agrandir
        </span>
      </span>
    </button>
  );
}
