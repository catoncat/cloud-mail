import { X } from "lucide-react";
import { useEffect, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Button({
  className, variant = "outline", size = "md", ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "ghost" | "danger";
  size?: "sm" | "md" | "icon";
}) {
  return (
    <button
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium transition-colors",
        "disabled:pointer-events-none disabled:opacity-50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-1 dark:focus-visible:ring-zinc-50 dark:focus-visible:ring-offset-zinc-950",
        size === "sm" && "h-7 px-2.5 text-xs",
        size === "md" && "h-9 px-3.5 text-sm",
        size === "icon" && "h-7 w-7 p-0",
        variant === "primary" && "bg-zinc-900 text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200",
        variant === "outline" && "border border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800",
        variant === "ghost" && "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-50",
        variant === "danger" && "border border-zinc-200 bg-white text-red-600 hover:border-red-200 hover:bg-red-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-red-950/40",
        className,
      )}
      {...props}
    />
  );
}

export function IconButton({
  label, className, ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & { label: string }) {
  return <Button size="icon" variant="ghost" className={className} aria-label={label} title={label} {...props} />;
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm",
        "placeholder:text-zinc-400 focus-visible:border-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900",
        "disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:focus-visible:border-zinc-50 dark:focus-visible:ring-zinc-50",
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm",
        "focus-visible:border-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900",
        "dark:border-zinc-800 dark:bg-zinc-900 dark:focus-visible:border-zinc-50 dark:focus-visible:ring-zinc-50",
        className,
      )}
      {...props}
    />
  );
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900", className)} {...props} />;
}

export function Badge({
  className, children, tone = "neutral",
}: { className?: string; children: ReactNode; tone?: "neutral" | "good" | "warn" | "signal" }) {
  return (
    <span className={cn(
      "inline-flex h-5 items-center rounded px-1.5 text-[11px] font-medium",
      tone === "neutral" && "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
      (tone === "good" || tone === "signal") && "bg-zinc-900 text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900",
      tone === "warn" && "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
      className,
    )}>
      {children}
    </span>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-7 max-w-full items-center rounded-md bg-zinc-100 px-2.5 font-mono text-sm font-semibold tabular-nums dark:bg-zinc-800">
      {children}
    </span>
  );
}

export function BigCode({ value }: { value: string }) {
  if (value.length > 12) {
    return <div className="break-all font-mono text-3xl font-semibold tabular-nums sm:text-4xl">{value}</div>;
  }
  return (
    <div className="flex flex-wrap justify-center gap-1.5 font-mono text-3xl font-semibold tabular-nums sm:gap-2 sm:text-[42px] sm:leading-none">
      {[...value].map((char, index) => <span key={`${char}-${index}`}>{char}</span>)}
    </div>
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

export function SignalDot({ active = false }: { active?: boolean }) {
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0">
      {active && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-zinc-500 opacity-30 motion-reduce:hidden" />}
      <span className={cn("relative inline-flex h-2.5 w-2.5 rounded-full", active ? "bg-zinc-900 dark:bg-zinc-50" : "bg-zinc-300 dark:bg-zinc-700")} />
    </span>
  );
}

export function Segmented<T extends string>({
  value, options, onChange,
}: { value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
  return (
    <div className="inline-flex h-8 items-center rounded-md bg-zinc-100 p-0.5 dark:bg-zinc-900" role="group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={cn(
            "h-7 rounded px-2.5 text-xs font-medium transition-colors",
            value === option.value
              ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-50"
              : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-50",
          )}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Dialog({
  open, title, description, children, onClose,
}: { open: boolean; title: string; description?: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-end bg-zinc-950/35 p-0 backdrop-blur-[2px] sm:place-items-center sm:p-6" onMouseDown={onClose}>
      <div
        className="max-h-[calc(100svh-3rem)] w-full max-w-lg overflow-y-auto rounded-t-lg border border-zinc-200 bg-white p-5 shadow-2xl sm:rounded-lg dark:border-zinc-800 dark:bg-zinc-900"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 id="dialog-title" className="text-base font-semibold">{title}</h2>
            {description && <p className="mt-1 text-[13px] leading-relaxed text-zinc-500">{description}</p>}
          </div>
          <IconButton label="关闭" onClick={onClose}><X className="h-4 w-4" /></IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}
