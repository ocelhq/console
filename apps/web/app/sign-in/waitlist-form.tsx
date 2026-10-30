"use client";

import { type FormEvent, useState } from "react";
import { AuthError } from "@/components/auth-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { labelType } from "@/lib/type";

type State =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "done" }
  | { kind: "error"; message: string };

export function WaitlistForm({ endpoint }: { endpoint: string }) {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") ?? "");
    setState({ kind: "sending" });
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, source: "console" }),
    }).catch(() => null);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
      setState({ kind: "error", message: body?.error ?? "That didn't go through. Try again." });
      return;
    }
    setState({ kind: "done" });
  }

  if (state.kind === "done") {
    return <p className="text-sm">You're on the list. We'll email you an invite.</p>;
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 border-t border-border pt-5">
      <p className="text-sm text-muted-foreground">
        New here? Sign-up is by invite during the alpha.
      </p>
      <label className="flex flex-col gap-2">
        <span className={labelType}>Email</span>
        <Input name="email" type="email" autoComplete="email" required className="h-9" />
      </label>
      <Button
        type="submit"
        variant="outline"
        disabled={state.kind === "sending"}
        className="h-10 w-full"
      >
        {state.kind === "sending" ? "Sending…" : "Join the waitlist"}
      </Button>
      {state.kind === "error" && <AuthError>{state.message}</AuthError>}
    </form>
  );
}
