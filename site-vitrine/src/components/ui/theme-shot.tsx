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
  const loading = eager ? "eager" : "lazy";
  return (
    <span className={wrapperClassName}>
      <img
        src={`${import.meta.env.BASE_URL}shots/${name}-dark.webp`}
        alt={alt}
        width={width}
        height={height}
        loading={loading}
        decoding="async"
        className={`shot-dark ${className ?? ""}`}
      />
      <img
        src={`${import.meta.env.BASE_URL}shots/${name}-light.webp`}
        alt=""
        aria-hidden="true"
        width={width}
        height={height}
        loading={loading}
        decoding="async"
        className={`shot-light ${className ?? ""}`}
      />
    </span>
  );
}
