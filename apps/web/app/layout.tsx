import type { Metadata } from "next";
import { connection } from "next/server";
import { ThemeProvider } from "next-themes";
import { Suspense } from "react";
import "./globals.css";
import { Analytics } from "@/components/analytics";
import { TooltipProvider } from "@/components/ui/tooltip";
import { readAnalytics } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { fontVariables } from "./fonts";

export const metadata: Metadata = {
  title: "Ocel Console",
  description: "Manage Ocel deployments in your cloud account.",
};

async function StartAnalytics() {
  await connection();
  const analytics = readAnalytics();
  return analytics ? <Analytics token={analytics.token} uiHost={analytics.uiHost} /> : null;
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-register="operate"
      suppressHydrationWarning
      className={cn("h-full", "antialiased", "font-sans", fontVariables)}
    >
      <body className="min-h-full flex flex-col text-sm/5">
        <Suspense>
          <StartAnalytics />
        </Suspense>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
