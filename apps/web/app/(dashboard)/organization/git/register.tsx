"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Start = { url: string; state: string; manifest: unknown };

export function RegisterGithubApp() {
  const [owner, setOwner] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function register(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const response = await fetch("/api/git/github/manifest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(owner.trim() ? { owner: owner.trim() } : {}),
    });
    if (!response.ok) {
      setPending(false);
      setError(
        response.status === 403
          ? "Only owners and admins can register a GitHub App."
          : "The console couldn’t start the registration. Check the GitHub organization name.",
      );
      return;
    }
    const start = (await response.json()) as Start;

    const form = document.createElement("form");
    form.method = "post";
    form.action = start.url;
    const manifest = document.createElement("input");
    manifest.type = "hidden";
    manifest.name = "manifest";
    manifest.value = JSON.stringify(start.manifest);
    form.append(manifest);
    document.body.append(form);
    form.submit();
  }

  return (
    <form onSubmit={register} className="flex max-w-md flex-col gap-3" noValidate>
      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium">GitHub organization</span>
        <Input
          value={owner}
          onChange={(event) => setOwner(event.target.value)}
          placeholder="Leave empty to register on your own account"
          autoComplete="off"
          spellCheck={false}
          disabled={pending}
        />
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Opening GitHub…" : "Register a GitHub App"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
