import type { ReactNode } from "react";

export function AuthPanel({
  title,
  description,
  children,
  aside,
}: {
  title: string;
  description: string;
  children?: ReactNode;
  aside?: ReactNode;
}) {
  const panel = (
    <div className="flex w-full max-w-sm flex-col gap-6 border border-border bg-card p-8">
      <div className="flex flex-col gap-3">
        <span className="font-display text-xl leading-none font-extrabold tracking-[-0.04em] lowercase text-foreground">
          ocel
        </span>
        <h1 className="text-2xl leading-tight font-semibold tracking-[-0.025em] text-balance text-foreground">
          {title}
        </h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );

  if (!aside) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background px-4 py-12">
        {panel}
      </div>
    );
  }

  return (
    <div className="grid flex-1 bg-background lg:grid-cols-[minmax(24rem,2fr)_3fr]">
      <div className="flex items-center justify-center px-4 py-12">{panel}</div>
      <aside className="hidden flex-col justify-center gap-6 overflow-hidden border-l border-border bg-muted py-12 pl-12 lg:flex">
        {aside}
      </aside>
    </div>
  );
}

export function AuthError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}
