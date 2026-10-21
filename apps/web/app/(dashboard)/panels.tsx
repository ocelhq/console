import type { ReactNode } from "react";
import { labelType } from "@/lib/type";
import { cn } from "@/lib/utils";

export function Joined({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-1 pt-px pl-px", className)}>{children}</div>;
}

export function Cell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("-mt-px -ml-px min-w-0 border border-border p-4", className)}>
      {children}
    </div>
  );
}

export function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <Cell className="flex flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{name}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </Cell>
  );
}

export function NotReported() {
  return <span className="text-muted-foreground">Not reported</span>;
}

export function Panel({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <Cell className="flex flex-col gap-3">
      <h2 className={labelType}>{heading}</h2>
      {children}
    </Cell>
  );
}
