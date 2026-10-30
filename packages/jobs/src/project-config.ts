import { type ParseError, parse as parseJsonc } from "jsonc-parser/lib/esm/main.js";
import { parse as parseYaml } from "yaml";

export type ReadFile = (path: string) => Promise<string | undefined>;

export type ConfiguredProvider =
  | { ok: true; provider: string; slug?: string }
  | { ok: false; message: string };

const CONFIG_NAMES = ["ocel.json", "ocel.yaml", "ocel.yml", "ocel.config.ts"] as const;

function refused(message: string): ConfiguredProvider {
  return { ok: false, message };
}

function parsed(
  name: string,
  text: string,
): { ok: true; doc: unknown } | { ok: false; message: string } {
  if (name.endsWith(".json")) {
    const errors: ParseError[] = [];
    const doc: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
    return errors.length > 0
      ? { ok: false, message: `${name} is not valid JSON` }
      : { ok: true, doc };
  }
  try {
    return { ok: true, doc: parseYaml(text) };
  } catch {
    return { ok: false, message: `${name} is not valid YAML` };
  }
}

function providerOf(name: string, doc: unknown): ConfiguredProvider {
  const { provider, slug } =
    typeof doc === "object" && doc !== null
      ? (doc as { provider?: unknown; slug?: unknown })
      : { provider: undefined, slug: undefined };
  const named = typeof slug === "string" && slug !== "" ? { slug } : {};
  if (provider === undefined || provider === null) return { ok: true, provider: "", ...named };
  if (typeof provider === "string") return { ok: true, provider, ...named };
  if (typeof provider === "object" && !Array.isArray(provider)) {
    const keys = Object.keys(provider);
    if (keys.length === 1 && keys[0]) return { ok: true, provider: keys[0], ...named };
  }
  return refused(`the provider in ${name} names no one provider`);
}

export async function configuredProvider(
  read: ReadFile,
  projectPath: string,
): Promise<ConfiguredProvider> {
  const dir = projectPath.replace(/^\/+|\/+$/g, "");
  for (const name of CONFIG_NAMES) {
    const path = dir ? `${dir}/${name}` : name;
    const text = await read(path);
    if (text === undefined) continue;
    if (name === "ocel.config.ts") {
      return refused(
        `the project's config is ${path}, which the console cannot evaluate to learn its provider`,
      );
    }
    const doc = parsed(path, text);
    return doc.ok ? providerOf(path, doc.doc) : refused(doc.message);
  }
  return { ok: true, provider: "" };
}
