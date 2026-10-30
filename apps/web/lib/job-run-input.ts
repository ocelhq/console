import type { NeededVariable, RunJob, VariableAnswer } from "@console/api";
import type { Tier } from "@console/db/schema";

export type VariablesInput = Extract<NonNullable<RunJob["input"]>, { kind: "variables" }>;

export interface InputFolder {
  folder: string;
  variables: NeededVariable[];
}

export interface InputSection {
  group: string;
  description: string;
  folders: InputFolder[];
}

export function fieldKey(variable: Pick<NeededVariable, "key" | "folder">): string {
  return `${variable.folder}#${variable.key}`;
}

export function folderLabel(folder: string): string {
  return folder === "" ? "Project root" : folder.replace(/^\//, "");
}

const tierHeadings: Record<Tier, string> = {
  production: "Production values",
  preview: "Preview values",
};

export function tierHeading(tier: Tier | null): string {
  return tier ? tierHeadings[tier] : "Values";
}

export function spansFolders(variables: readonly NeededVariable[]): boolean {
  return new Set(variables.map((variable) => variable.folder)).size > 1;
}

export function sectionsOf(input: Pick<VariablesInput, "variables" | "groups">): InputSection[] {
  const descriptions = new Map(input.groups.map((group) => [group.key, group.description]));
  const sections = new Map<string, Map<string, NeededVariable[]>>();
  const ungrouped = input.variables.filter((variable) => variable.group === "");
  const grouped = input.variables.filter((variable) => variable.group !== "");
  for (const variable of [...ungrouped, ...grouped]) {
    const folders = sections.get(variable.group) ?? new Map<string, NeededVariable[]>();
    sections.set(variable.group, folders);
    const listed = folders.get(variable.folder) ?? [];
    folders.set(variable.folder, listed);
    listed.push(variable);
  }
  return [...sections].map(([group, folders]) => ({
    group,
    description: descriptions.get(group) ?? "",
    folders: [...folders]
      .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
      .map(([folder, variables]) => ({ folder, variables })),
  }));
}

export function isBlank(value: string | undefined): boolean {
  return (value ?? "").trim() === "";
}

export function blankFields(
  variables: readonly NeededVariable[],
  typed: ReadonlyMap<string, string>,
): NeededVariable[] {
  return variables.filter((variable) => isBlank(typed.get(fieldKey(variable))));
}

export function answerOf(
  variables: readonly NeededVariable[],
  typed: ReadonlyMap<string, string>,
): VariableAnswer[] {
  return variables.map((variable) => ({
    key: variable.key,
    folder: variable.folder,
    value: typed.get(fieldKey(variable)) ?? "",
  }));
}

export function pasteInto(
  current: string,
  pasted: string,
  start: number | null,
  end: number | null,
): string {
  const from = start ?? current.length;
  const to = end ?? from;
  return current.slice(0, from) + pasted + current.slice(to);
}

export function isMultiline(value: string): boolean {
  return /[\r\n]/.test(value);
}
