import { cn } from "@/lib/utils";
import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export function Button({
  className, variant = "outline", size = "md", ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "outline" | "ghost" | "danger"; size?: "sm" | "md" }) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors",
        "disabled:pointer-events-none disabled:opacity-50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-1 dark:focus-visible:ring-zinc-50",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        variant === "primary" && "bg-zinc-900 text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200",
        variant === "outline" && "border border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800",
        variant === "ghost" && "hover:bg-zinc-100 dark:hover:bg-zinc-800",
        variant === "danger" && "border border-zinc-200 bg-white text-red-600 hover:bg-red-50 hover:border-red-200 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-red-950/40",
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm",
        "placeholder:text-zinc-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:border-zinc-900",
        "disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:focus-visible:ring-zinc-50 dark:focus-visible:border-zinc-50",
        className,
      )}
      {...props}
    />
  );
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900", className)} {...props} />;
}

export function Badge({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex h-5 items-center rounded px-1.5 text-[11px] font-medium", "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400", className)}>
      {children}
    </span>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-7 items-center rounded-md bg-zinc-100 px-2.5 font-mono text-sm font-semibold tabular-nums tracking-wider dark:bg-zinc-800">
      {children}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-200 bg-white px-5 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900">
      {children}
    </div>
  );
}

export function Row({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex min-h-[46px] items-center gap-3 border-t border-zinc-100 px-3.5 py-2 first:border-t-0 dark:border-zinc-800", className)} {...props} />;
}

export function Spinner() {
  return <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-zinc-300 border-t-zinc-900 dark:border-zinc-700 dark:border-t-zinc-100" />;
}
