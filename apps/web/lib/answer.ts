export type Answer<T = null> = { ok: true; result: T } | { ok: false; message: string };

export const done = { ok: true, result: null } as const;

export function failed(message: string): Answer<never> {
  return { ok: false, message };
}

export async function attempt<T>(run: () => Promise<Answer<T>>): Promise<Answer<T>> {
  try {
    return await run();
  } catch (thrown) {
    return failed(thrown instanceof Error ? thrown.message : String(thrown));
  }
}
