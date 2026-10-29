export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type RetryPolicy = {
  attempts: number;
  minDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
};

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 5,
  minDelayMs: 1_000,
  maxDelayMs: 60_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    body: string,
  ) {
    super(`GET ${url} answered ${status}${body ? `: ${body.slice(0, 500)}` : ""}`);
  }
}

export async function fetchOk(
  fetcher: Fetch,
  url: string,
  init: RequestInit = {},
  policy: RetryPolicy = DEFAULT_RETRY,
): Promise<Response> {
  let failure: unknown;
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    let wait: number | undefined;
    try {
      const response = await fetcher(url, init);
      if (response.ok) return response;
      const body = await response.text().catch(() => "");
      failure = new HttpError(url, response.status, body);
      if (response.status !== 429 && response.status < 500) throw failure;
      wait = retryAfterMs(response.headers.get("retry-after"));
    } catch (error) {
      if (error instanceof HttpError && error.status !== 429 && error.status < 500) throw error;
      if (init.signal?.aborted) throw error;
      failure = error;
    }
    if (attempt === policy.attempts) break;
    const ceiling = Math.min(policy.maxDelayMs, policy.minDelayMs * 2 ** (attempt - 1));
    const backoff = ceiling / 2 + (policy.random() * ceiling) / 2;
    if (wait !== undefined && wait > policy.maxDelayMs) break;
    await policy.sleep(Math.max(wait ?? 0, backoff));
  }
  throw failure;
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

export async function fetchJson<T>(
  fetcher: Fetch,
  url: string,
  init?: RequestInit,
  policy?: RetryPolicy,
): Promise<T> {
  const response = await fetchOk(fetcher, url, init, policy);
  return (await response.json()) as T;
}
