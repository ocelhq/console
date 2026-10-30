"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Answer } from "@/lib/answer";
import { field } from "../git/shared";

export type Choice = { id: string; label: string };

export function TierPicker({
  tier,
  noun,
  choices,
  bound,
  administers,
  shown,
  save,
  changed = () => false,
  extra,
  notice,
}: {
  tier: string;
  noun: string;
  choices: Choice[];
  bound: string | null;
  administers: boolean;
  shown: string;
  save(chosen: string): Promise<Answer>;
  changed?(chosen: string): boolean;
  extra?(chosen: string, pending: boolean): ReactNode;
  notice?: ReactNode;
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState(bound ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unchanged = chosen === (bound ?? "") && !changed(chosen);

  async function saved() {
    setPending(true);
    setError(null);
    const answer = await save(chosen);
    setPending(false);
    if (!answer.ok) {
      setError(answer.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium capitalize">{tier}</p>
      {administers ? (
        <div className="flex flex-wrap items-center gap-3">
          <select
            className={`${field} max-w-md`}
            value={chosen}
            onChange={(event) => setChosen(event.target.value)}
            disabled={pending}
            aria-label={`${noun} for ${tier}`}
          >
            <option value="">No {noun.toLowerCase()}</option>
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
          {extra?.(chosen, pending)}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending || unchanged}
            onClick={saved}
          >
            {pending ? "Saving…" : chosen ? "Bind" : "Unbind"}
          </Button>
        </div>
      ) : (
        <p className="font-mono text-xs">{shown}</p>
      )}
      {notice}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
