import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { A } from "./Link";

type ButtonProps = {
  href: string;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
  /** Icon vor (`start`) oder nach (`end`) dem Text. */
  icon?: IconName;
  iconPosition?: "start" | "end";
  children: ReactNode;
  className?: string;
};

export function Button({ href, variant = "primary", size = "md", icon, iconPosition = "end", children, className }: ButtonProps) {
  const cls = ["btn", `btn-${variant}`, size === "lg" ? "btn-lg" : size === "sm" ? "btn-sm" : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <A href={href} className={cls}>
      {icon && iconPosition === "start" && <Icon name={icon} />}
      {children}
      {icon && iconPosition === "end" && <Icon name={icon} />}
    </A>
  );
}
