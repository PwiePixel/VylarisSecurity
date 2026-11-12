import { iconPaths, type IconName } from "./icon-paths";

export type { IconName };

type IconProps = {
  name: IconName;
  className?: string;
};

/** Dekoratives Strich-Icon (24×24). Die Pfade liegen als Konstanten in icon-paths.ts. */
export function Icon({ name, className }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      dangerouslySetInnerHTML={{ __html: iconPaths[name] }}
    />
  );
}
