"use client";

import type { CloudJob } from "@console/api";
import { StopCircleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cancelJob, type JobRef, refusalOf } from "@/lib/cloud-job-client";

export function CancelJob({ job, onCanceled }: { job: JobRef; onCanceled(job: CloudJob): void }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setError(null);
    setPending(true);
    const reply = await cancelJob(job);
    setPending(false);
    if (reply.kind !== "ok") {
      setError(refusalOf(reply, "The job wasn’t canceled. Try again."));
      return;
    }
    onCanceled(reply.value);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" />}>
        <StopCircleIcon data-icon="inline-start" />
        Cancel job
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-3 p-4">
        <PopoverHeader>
          <PopoverTitle>Cancel this job?</PopoverTitle>
          <PopoverDescription>
            Ocel Cloud stops it at the current step. Steps that already finished are not undone.
          </PopoverDescription>
        </PopoverHeader>
        <div className="flex items-center gap-2">
          <Button type="button" variant="destructive" size="sm" disabled={pending} onClick={cancel}>
            {pending ? "Canceling…" : "Cancel job"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Keep running
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
