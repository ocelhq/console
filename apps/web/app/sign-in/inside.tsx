import Image from "next/image";
import consoleLight from "./console.jpg";
import consoleDark from "./console-dark.jpg";

const alt = "The console's project list, with projects on Ocel Cloud, AWS, Google Cloud and a VPS.";

export function Inside() {
  return (
    <>
      <div className="flex max-w-md flex-col gap-2 pr-12">
        <h2 className="text-lg font-semibold tracking-[-0.015em] text-foreground">
          Every app, wherever it runs
        </h2>
        <p className="text-sm text-muted-foreground">
          Deployments, variables and your team for projects on Ocel Cloud, AWS, Google Cloud or your
          own VPS, in one place.
        </p>
      </div>
      <div className="border-y border-l border-border bg-card">
        <Image
          src={consoleLight}
          alt={alt}
          sizes="60vw"
          priority
          className="block h-auto w-full max-w-none dark:hidden"
        />
        <Image
          src={consoleDark}
          alt={alt}
          sizes="60vw"
          className="hidden h-auto w-full max-w-none dark:block"
        />
      </div>
    </>
  );
}
