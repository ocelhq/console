"use client";

import type { Tier } from "@console/db/schema";
import { CaretUpDownIcon } from "@phosphor-icons/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { tierOf, tiers } from "@/lib/tier";

export function EnvironmentSwitcher() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tier = tierOf(searchParams.get("env"));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Environment: ${tier}. Switch environment`}
        className="flex h-8 shrink-0 items-center gap-1.5 px-2 font-medium outline-hidden transition-colors hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring data-popup-open:bg-muted"
      >
        {tier}
        <CaretUpDownIcon className="size-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-44 p-1">
        <DropdownMenuRadioGroup
          value={tier}
          onValueChange={(next: Tier) => {
            const params = new URLSearchParams(searchParams);
            if (next === "production") {
              params.delete("env");
            } else {
              params.set("env", next);
            }
            const query = params.toString();
            router.push(query ? `${pathname}?${query}` : pathname);
          }}
        >
          {tiers.map((item) => (
            <DropdownMenuRadioItem key={item} value={item} className="px-2.5 py-2 text-sm">
              {item}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
