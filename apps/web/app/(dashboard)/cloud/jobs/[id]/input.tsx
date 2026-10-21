"use client";

import type { CloudJob, CloudJobInput, JobAnswer, NeededVariable } from "@console/api";
import { EyeIcon, EyeSlashIcon, HandPalmIcon } from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { type JobRef, type Lost, respondToJob } from "@/lib/cloud-job-client";
import {
  answerOf,
  blankFields,
  fieldKey,
  folderLabel,
  isBlank,
  isMultiline,
  pasteInto,
  sectionsOf,
  spansFolders,
  tierHeading,
  type VariablesInput,
} from "@/lib/cloud-job-input";
import { labelType } from "@/lib/type";
import { cn } from "@/lib/utils";

type ConfirmationInput = Extract<CloudJobInput, { kind: "confirmation" }>;

interface Answering {
  job: JobRef;
  onAnswered(inputId: string, job: CloudJob): void;
  onStale(): void;
  onLost(why: Lost): void;
}

async function answerWith(
  { job, onAnswered, onStale, onLost }: Answering,
  inputId: string,
  answer: JobAnswer,
  fallback: string,
): Promise<string | null> {
  const reply = await respondToJob(job, inputId, answer);
  if (reply.kind === "ok") {
    onAnswered(inputId, reply.value);
    return null;
  }
  if (reply.kind === "lost") {
    onLost(reply.why);
    return null;
  }
  if (reply.kind === "stale") onStale();
  return reply.message ?? fallback;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function introOf(input: CloudJobInput | null): string {
  if (input?.kind === "variables") {
    return `${plural(input.variables.length, "variable has", "variables have")} no usable value. Fill ${input.variables.length === 1 ? "it" : "them"} in and the job carries on.`;
  }
  if (input?.kind === "confirmation") {
    return "It is paused until someone answers.";
  }
  return "It is paused until someone answers. Whatever it is waiting for is in the last lines of the log.";
}

export function InputRequired({
  input,
  sent,
  mayGiveValues,
  answering,
}: {
  input: CloudJob["input"];
  sent: boolean;
  mayGiveValues: boolean;
  answering: Answering;
}) {
  return (
    <section
      aria-labelledby="job-input"
      className="flex flex-col gap-4 border border-border bg-warn/10 p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id="job-input" className="inline-flex items-center gap-2 text-sm font-semibold">
          <HandPalmIcon aria-hidden className="size-4 text-warn" />
          This job needs your input
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">{introOf(input)}</p>
      </div>
      <div data-slot="job-input" className="border border-border bg-background">
        {sent ? (
          <p role="status" className="px-4 py-3 text-sm">
            Answer sent. Waiting for the job to carry on…
          </p>
        ) : input?.kind === "variables" && !mayGiveValues ? (
          <ValuesForOthers input={input} />
        ) : input?.kind === "variables" ? (
          <VariablesForm key={input.id} input={input} answering={answering} />
        ) : input?.kind === "confirmation" ? (
          <ConfirmationForm key={input.id} input={input} answering={answering} />
        ) : (
          <p className="max-w-prose px-4 py-3 text-sm text-muted-foreground">
            This console can’t answer what the job is asking. Cancel the job, settle it from your
            terminal and run the command again.
          </p>
        )}
      </div>
    </section>
  );
}

function ValuesForOthers({ input }: { input: VariablesInput }) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3 text-sm">
      <p className="max-w-prose">
        Giving these values takes an admin or an owner of this organization. Ask one of them to open
        this page.
      </p>
      <ul className="font-mono text-xs">
        {input.variables.map((variable) => (
          <li key={fieldKey(variable)}>{variable.key}</li>
        ))}
      </ul>
    </div>
  );
}

function Feedback({
  pending,
  sending,
  error,
}: {
  pending: boolean;
  sending: string;
  error: string | null;
}) {
  return (
    <>
      <p aria-live="polite" className="text-xs text-muted-foreground">
        {pending ? sending : ""}
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  );
}

function ConfirmationForm({
  input,
  answering,
}: {
  input: ConfirmationInput;
  answering: Answering;
}) {
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function answer(confirmed: boolean) {
    if (pending !== null) return;
    setError(null);
    setPending(confirmed);
    setError(
      await answerWith(answering, input.id, { confirmed }, "The answer wasn’t sent. Try again."),
    );
    setPending(null);
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {input.finding && <p className="max-w-prose text-sm whitespace-pre-wrap">{input.finding}</p>}
      <p id={`question-${input.id}`} className="max-w-prose text-sm font-semibold">
        {input.question}
      </p>
      <fieldset
        aria-labelledby={`question-${input.id}`}
        className="flex flex-wrap items-center gap-2"
      >
        <Button
          type="button"
          variant="destructive"
          disabled={pending !== null}
          onClick={() => void answer(true)}
        >
          {pending === true ? "Continuing…" : "Continue"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending !== null}
          onClick={() => void answer(false)}
        >
          {pending === false ? "Stopping…" : "Don’t continue"}
        </Button>
      </fieldset>
      <Feedback
        pending={pending !== null}
        sending="Sending your answer to Ocel Cloud…"
        error={error}
      />
    </div>
  );
}

function VariablesForm({ input, answering }: { input: VariablesInput; answering: Answering }) {
  const formId = useId();
  const sections = sectionsOf(input);
  const ordered = sections.flatMap((section) =>
    section.folders.flatMap((folder) => folder.variables),
  );
  const byFolder = spansFolders(input.variables);
  const [typed, setTyped] = useState<ReadonlyMap<string, string>>(new Map());
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const [flagged, setFlagged] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields = useRef(new Map<string, HTMLInputElement | HTMLTextAreaElement>());
  const first = ordered[0] ? fieldKey(ordered[0]) : null;

  useEffect(() => {
    if (first) fields.current.get(first)?.focus();
  }, [first]);

  function type(variable: NeededVariable, value: string) {
    const key = fieldKey(variable);
    setTyped((current) => new Map(current).set(key, value));
    if (!isBlank(value) && flagged.has(key)) {
      setFlagged((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  function toggle(key: string) {
    setShown((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const blank = blankFields(ordered, typed);
    if (blank.length > 0) {
      setFlagged(new Set(blank.map(fieldKey)));
      setError(
        blank.length === 1
          ? `${blank[0].key} needs a value.`
          : `${blank.length} variables need a value.`,
      );
      fields.current.get(fieldKey(blank[0]))?.focus();
      return;
    }
    setFlagged(new Set());
    setError(null);
    setPending(true);
    setError(
      await answerWith(
        answering,
        input.id,
        { variables: { values: answerOf(ordered, typed) } },
        "The values weren’t sent. Try again.",
      ),
    );
    setPending(false);
  }

  const row = (variable: NeededVariable) => {
    const key = fieldKey(variable);
    const id = `${formId}-${ordered.indexOf(variable)}`;
    return (
      <VariableRow
        key={key}
        id={id}
        variable={variable}
        value={typed.get(key) ?? ""}
        invalid={flagged.has(key)}
        revealed={shown.has(key)}
        disabled={pending}
        register={(element) => {
          if (element) fields.current.set(key, element);
          else fields.current.delete(key);
        }}
        onChange={(value) => type(variable, value)}
        onToggle={() => toggle(key)}
      />
    );
  };

  return (
    <form
      noValidate
      onSubmit={submit}
      aria-labelledby={`${formId}-heading`}
      className="flex flex-col"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border px-4 py-3">
        <h3 id={`${formId}-heading`} className={labelType}>
          {tierHeading(input.tier)}
        </h3>
        <span className="text-xs text-muted-foreground">
          {plural(input.variables.length, "variable", "variables")}
        </span>
      </div>
      {sections.map((section) => (
        <Section key={section.group} group={section.group} description={section.description}>
          {section.folders.map((folder) =>
            byFolder ? (
              <div key={folder.folder} className="flex flex-col">
                <p aria-hidden className="px-4 pt-3 font-mono text-xs text-muted-foreground">
                  {folderLabel(folder.folder)}
                </p>
                <ul aria-label={folderLabel(folder.folder)} className="flex flex-col">
                  {folder.variables.map(row)}
                </ul>
              </div>
            ) : (
              <ul key={folder.folder} className="flex flex-col">
                {folder.variables.map(row)}
              </ul>
            ),
          )}
        </Section>
      ))}
      <div className="flex flex-col gap-3 border-t border-border px-4 py-3">
        <p className="max-w-prose text-xs text-muted-foreground">
          The values go to Ocel Cloud’s variable store, as this project’s{" "}
          {input.tier ?? "environment’s"} values. The console doesn’t keep them.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save and continue"}
          </Button>
          <Feedback pending={pending} sending="Sending the values to Ocel Cloud…" error={error} />
        </div>
      </div>
    </form>
  );
}

function Section({
  group,
  description,
  children,
}: {
  group: string;
  description: string;
  children: ReactNode;
}) {
  if (group === "") {
    return <div className="flex flex-col border-b border-border last:border-b-0">{children}</div>;
  }
  return (
    <section className="flex flex-col border-b border-border">
      <div className="flex flex-col gap-1 px-4 pt-4">
        <h4 className="font-mono text-[13px] font-medium">{group}</h4>
        {description && <p className="max-w-prose text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function VariableRow({
  id,
  variable,
  value,
  invalid,
  revealed,
  disabled,
  register,
  onChange,
  onToggle,
}: {
  id: string;
  variable: NeededVariable;
  value: string;
  invalid: boolean;
  revealed: boolean;
  disabled: boolean;
  register(element: HTMLInputElement | HTMLTextAreaElement | null): void;
  onChange(value: string): void;
  onToggle(): void;
}) {
  const masked = variable.secret && !revealed;
  const folded = masked && isMultiline(value);
  const described = [
    variable.description && `${id}-description`,
    variable.reason && `${id}-reason`,
    folded && `${id}-folded`,
  ]
    .filter(Boolean)
    .join(" ");
  const control = {
    id,
    disabled,
    autoComplete: "off",
    spellCheck: false,
    "aria-required": true,
    "aria-invalid": invalid || undefined,
    "aria-describedby": described || undefined,
    "data-1p-ignore": true,
    "data-lpignore": "true",
    className: "font-mono text-[13px] md:text-[13px]",
  } as const;
  return (
    <li
      data-slot="needed-variable"
      className="grid gap-x-6 gap-y-2 border-t border-border px-4 py-3 first:border-t-0 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <label htmlFor={id} className="font-mono text-[13px] break-all">
            {variable.key}
          </label>
          {variable.secret && <span className={labelType}>Secret</span>}
        </span>
        {variable.description && (
          <p id={`${id}-description`} className="text-xs text-muted-foreground">
            {variable.description}
          </p>
        )}
        {variable.reason && (
          <p id={`${id}-reason`} className="text-xs text-warn">
            {variable.reason}
          </p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-start gap-1">
          {masked ? (
            <Input
              {...control}
              ref={register}
              type="password"
              value={folded ? value.replace(/[\r\n]+/g, " ") : value}
              readOnly={folded}
              onChange={(event) => onChange(event.currentTarget.value)}
              onPaste={(event) => {
                const pasted = event.clipboardData.getData("text");
                if (!isMultiline(pasted)) return;
                event.preventDefault();
                const target = event.currentTarget;
                onChange(pasteInto(value, pasted, target.selectionStart, target.selectionEnd));
              }}
            />
          ) : (
            <Textarea
              {...control}
              ref={register}
              rows={1}
              value={value}
              className={cn(control.className, "min-h-8 py-1.5")}
              onChange={(event) => onChange(event.currentTarget.value)}
            />
          )}
          {variable.secret && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-pressed={revealed}
              aria-label={`${revealed ? "Hide" : "Show"} the value of ${variable.key}`}
              title={revealed ? "Hide the value" : "Show the value"}
              onClick={onToggle}
            >
              {revealed ? <EyeSlashIcon aria-hidden /> : <EyeIcon aria-hidden />}
            </Button>
          )}
        </div>
        {folded && (
          <p id={`${id}-folded`} className="text-xs text-muted-foreground">
            A value over several lines. Show it to edit.
          </p>
        )}
      </div>
    </li>
  );
}
