import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Spinner } from "./spinner";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const base =
  "pressable inline-flex items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap select-none " +
  "disabled:opacity-45 disabled:cursor-not-allowed aria-disabled:opacity-45 aria-disabled:pointer-events-none";

const variants: Record<Variant, string> = {
  primary: "bg-ink text-canvas hover:opacity-90",
  secondary: "bg-surface text-ink border border-hairline-strong hover:bg-surface-2",
  ghost: "text-ink-2 hover:text-ink hover:bg-sunken/60",
  danger: "bg-surface text-danger border border-hairline-strong hover:bg-danger-soft",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3.5 text-caption",
  md: "h-10 px-5 text-callout",
  lg: "h-12 px-7 text-body",
};

export function buttonClasses(variant: Variant = "primary", size: Size = "md", className?: string) {
  return cn(base, variants[variant], sizes[size], className);
}

type ButtonProps = ComponentProps<"button"> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
};

export function Button({ variant, size, loading, icon, className, children, disabled, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={buttonClasses(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
}

type ButtonLinkProps = ComponentProps<typeof Link> & { variant?: Variant; size?: Size; icon?: ReactNode };

export function ButtonLink({ variant, size, icon, className, children, ...rest }: ButtonLinkProps) {
  return (
    <Link className={buttonClasses(variant, size, className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}
