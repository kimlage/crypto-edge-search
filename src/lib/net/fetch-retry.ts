/**
 * `fetch` with bounded exponential backoff and full jitter.
 *
 * Network calls to exchange / data APIs fail transiently: a momentary 503, a rate
 * limit (429), or a dropped connection. Retrying naively — fixed delay, or backoff
 * without jitter — synchronises many clients into retry storms that hammer the very
 * endpoint that is already struggling. This wraps a single logical request with:
 *
 *   - exponential backoff: delay grows as baseDelayMs × 2^attempt, capped at maxDelayMs;
 *   - FULL jitter: the actual sleep is a uniform random draw in [0, cappedDelay], which
 *     decorrelates concurrent clients (AWS Architecture Blog, "Exponential Backoff And
 *     Jitter"). Full jitter both spreads load and keeps the expected delay sane;
 *   - Retry-After: when the server sends a `Retry-After` header (delta-seconds OR an
 *     HTTP-date), we honour it verbatim instead of our computed backoff — the server
 *     knows better than we do when it will be ready;
 *   - retry triggers: a configurable set of HTTP status codes PLUS any thrown error from
 *     the underlying fetch (network failure, DNS, abort). On the final attempt we stop
 *     retrying and surface the last response/error to the caller.
 *
 * Determinism & testability: `fetchImpl`, `sleep`, `random`, and `now` are all injectable.
 * Tests pass a no-op `sleep` (so there are NO real timers and the suite is instant), a
 * seeded/stubbed `random`, and a fake `fetchImpl`. In production the defaults use the
 * global `fetch`, a real `setTimeout`-based sleep, `Math.random`, and `Date.now`.
 *
 * This module performs no logging and mutates no shared state; the only impurity is the
 * injected fetch/sleep/random/now, which the caller controls.
 */

/** Options controlling the retry policy. All have sensible production defaults. */
export interface FetchWithRetryOptions {
  /**
   * Maximum number of RETRIES after the initial attempt. `retries = 4` means up to 5
   * total attempts. Must be a non-negative integer.
   */
  retries?: number;
  /** Base delay in milliseconds for the exponential schedule (attempt 0). */
  baseDelayMs?: number;
  /** Upper bound (ms) on any single computed backoff delay, before jitter. */
  maxDelayMs?: number;
  /** When true (default) apply full jitter: sleep ~ Uniform[0, cappedDelay]. */
  jitter?: boolean;
  /** HTTP status codes that should trigger a retry. */
  retryOn?: number[];
  /** The fetch implementation to use. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Sleeps for `ms` milliseconds. Defaults to a real `setTimeout`-based delay. */
  sleep?: (ms: number) => Promise<void>;
  /** Returns a float in [0, 1). Defaults to `Math.random`. Injected for determinism. */
  random?: () => number;
  /** Returns "now" in epoch milliseconds. Defaults to `Date.now`. Used for Retry-After dates. */
  now?: () => number;
  /** Optional callback invoked before each backoff sleep, for observability/tests. */
  onRetry?: (info: RetryInfo) => void;
}

/** Describes one impending retry, passed to the optional `onRetry` callback. */
export interface RetryInfo {
  /** Zero-based index of the attempt that just FAILED (0 = first attempt). */
  attempt: number;
  /** The delay, in ms, we are about to sleep before the next attempt. */
  delayMs: number;
  /** The HTTP status that triggered the retry, if the failure was a response (not an error). */
  status?: number;
  /** The thrown error that triggered the retry, if the failure was a network error. */
  error?: unknown;
  /** True when `delayMs` came from a server `Retry-After` header rather than backoff. */
  fromRetryAfter: boolean;
}

const DEFAULTS = {
  retries: 4,
  baseDelayMs: 400,
  maxDelayMs: 20_000,
  jitter: true,
  retryOn: [429, 500, 502, 503, 504] as number[],
} as const;

/** Real-timer sleep used in production (never invoked by the deterministic tests). */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a `Retry-After` header value into a delay in milliseconds, or `null` if it is
 * absent / unparseable. The header may be either a non-negative integer count of seconds
 * (delta-seconds) or an HTTP-date; for a date we return the milliseconds until that date
 * relative to `nowMs`, clamped to be non-negative.
 */
export function parseRetryAfterMs(value: string | null, nowMs: number): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;

  // delta-seconds form: a bare non-negative integer.
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  // HTTP-date form.
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

/**
 * Compute the backoff delay (ms) for a given zero-based `attempt`, applying the
 * exponential schedule, the cap, and (optionally) full jitter via the injected `random`.
 * Exposed for unit testing the schedule in isolation.
 */
export function computeBackoffMs(
  attempt: number,
  opts: { baseDelayMs: number; maxDelayMs: number; jitter: boolean; random: () => number },
): number {
  const exponential = opts.baseDelayMs * 2 ** attempt;
  const capped = Math.min(exponential, opts.maxDelayMs);
  if (!opts.jitter) return capped;
  // Full jitter: uniform in [0, capped].
  return opts.random() * capped;
}

/**
 * Perform `fetch(url, init)` with retries. Resolves with the first successful (i.e.
 * non-retryable-status) `Response`, OR — after the retries are exhausted — the last
 * `Response` received. Rejects only if the final attempt threw (network error) and there
 * was no later successful response.
 *
 * @param url   The request URL or `Request`.
 * @param init  Standard `fetch` init, augmented with the retry options.
 */
export async function fetchWithRetry(
  url: string | URL | Request,
  init: (RequestInit & FetchWithRetryOptions) = {},
): Promise<Response> {
  const {
    retries = DEFAULTS.retries,
    baseDelayMs = DEFAULTS.baseDelayMs,
    maxDelayMs = DEFAULTS.maxDelayMs,
    jitter = DEFAULTS.jitter,
    retryOn = DEFAULTS.retryOn,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    random = Math.random,
    now = Date.now,
    onRetry,
    ...requestInit
  } = init;

  if (!Number.isInteger(retries) || retries < 0) {
    throw new RangeError(`retries must be a non-negative integer, got ${String(retries)}`);
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("No fetch implementation available (pass fetchImpl)");
  }

  const retryStatuses = new Set(retryOn);
  const maxAttempts = retries + 1;
  let lastError: unknown;
  let lastResponse: Response | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const isLastAttempt = attempt === maxAttempts - 1;

    let response: Response | undefined;
    try {
      response = await fetchImpl(url, requestInit);
    } catch (error) {
      lastError = error;
      lastResponse = undefined;
      if (isLastAttempt) throw error;
      const delayMs = computeBackoffMs(attempt, { baseDelayMs, maxDelayMs, jitter, random });
      onRetry?.({ attempt, delayMs, error, fromRetryAfter: false });
      await sleep(delayMs);
      continue;
    }

    lastResponse = response;
    lastError = undefined;

    // A status we do not retry on (typically 2xx, or a non-retryable 4xx) — done.
    if (!retryStatuses.has(response.status)) {
      return response;
    }

    // A retryable status. If we are out of attempts, return the response as-is so the
    // caller can inspect it; otherwise sleep (honouring Retry-After) and try again.
    if (isLastAttempt) {
      return response;
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), now());
    const fromRetryAfter = retryAfterMs != null;
    const delayMs = fromRetryAfter
      ? Math.min(retryAfterMs, maxDelayMs)
      : computeBackoffMs(attempt, { baseDelayMs, maxDelayMs, jitter, random });

    onRetry?.({ attempt, delayMs, status: response.status, fromRetryAfter });
    await sleep(delayMs);
  }

  // Loop only exits via the early returns above when a response existed; reaching here
  // means every attempt threw. Surface the last error (defensive — also covers retries<0
  // edge cases that the guard already rejects).
  if (lastResponse) return lastResponse;
  throw lastError ?? new Error("fetchWithRetry exhausted retries without a response");
}
