"use client";

import { useState } from "react";
import { AuthError, AuthPanel } from "@/components/auth-panel";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

function formatForDisplay(code: string) {
  if (code.length === 8) return `${code.slice(0, 4)}-${code.slice(4)}`;
  return code;
}

export function ApproveDevice({ userCode, signedInAs }: { userCode: string; signedInAs: string }) {
  const [status, setStatus] = useState<
    "idle" | "approving" | "denying" | "switching" | "approved" | "denied" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);

  if (!userCode) {
    return (
      <AuthPanel
        title="Missing code"
        description="No device code was provided. Go back to your terminal and re-run `ocel login`."
      />
    );
  }

  async function handleApprove() {
    setStatus("approving");
    setError(null);
    const { error: approveError } = await authClient.device.approve({
      userCode,
    });
    if (approveError) {
      setError(approveError.error_description ?? "Failed to approve device.");
      setStatus("error");
      return;
    }
    setStatus("approved");
  }

  async function handleDeny() {
    setStatus("denying");
    setError(null);
    const { error: denyError } = await authClient.device.deny({ userCode });
    if (denyError) {
      setError(denyError.error_description ?? "Failed to deny device.");
      setStatus("error");
      return;
    }
    setStatus("denied");
  }

  async function handleSwitchAccount() {
    setStatus("switching");
    setError(null);
    await authClient.signOut();
    const back = `/device/approve?user_code=${encodeURIComponent(userCode)}`;
    window.location.assign(`/sign-in?redirect=${encodeURIComponent(back)}`);
  }

  if (status === "approved") {
    return (
      <AuthPanel
        title="Device approved"
        description="You're all set. You can close this window and return to your terminal."
      />
    );
  }

  if (status === "denied") {
    return (
      <AuthPanel
        title="Device denied"
        description="You can close this window and return to your terminal."
      />
    );
  }

  const isBusy = status === "approving" || status === "denying" || status === "switching";

  return (
    <AuthPanel
      title="Confirm device sign-in"
      description="Approve this sign-in for your Ocel account."
    >
      <div className="border border-border bg-muted py-4 text-center font-mono text-2xl tracking-[0.3em] text-foreground uppercase">
        {formatForDisplay(userCode)}
      </div>

      <p className="text-sm text-muted-foreground">
        Check this code matches the one in your terminal. If you didn&apos;t run{" "}
        <code className="font-mono text-foreground">ocel login</code>, deny it.
      </p>

      <div className="flex items-center justify-between gap-3 border-t border-border pt-4 text-sm">
        <span className="min-w-0 truncate text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">{signedInAs}</span>
        </span>
        <button
          type="button"
          onClick={handleSwitchAccount}
          disabled={isBusy}
          className="shrink-0 text-muted-foreground underline underline-offset-4 hover:text-foreground disabled:opacity-50"
        >
          {status === "switching" ? "Signing out…" : "Switch account"}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={handleDeny}
          disabled={isBusy}
          className="h-10"
        >
          {status === "denying" ? "Denying…" : "Deny"}
        </Button>
        <Button type="button" onClick={handleApprove} disabled={isBusy} className="h-10">
          {status === "approving" ? "Approving…" : "Approve"}
        </Button>
      </div>

      {error && <AuthError>{error}</AuthError>}
    </AuthPanel>
  );
}
