import { describe, expect, it, vi } from "vitest";

import {
  computeBackoffMs,
  fetchWithRetry,
  parseRetryAfterMs,
} from "./fetch-retry";

/**
 * Build a minimal `Response`-like object that satisfies the fields `fetchWithRetry`
 * reads (`status` and `headers.get`). Using the real `Response` would also work, but a
 * tiny stub keeps the intent obvious and avoids any environment-specific behaviour.
 */
function makeResponse(status: number, headers: Record<string, string> = {}): Response {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
  } as unknown as Response;
}

/** A `sleep` stub that records every delay it was asked to wait, but never actually waits. */
function recordingSleep() {
  const delays: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { sleep, delays };
}

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds into milliseconds", () => {
    expect(parseRetryAfterMs("2", 0)).toBe(2000);
    expect(parseRetryAfterMs("0", 0)).toBe(0);
    expect(parseRetryAfterMs("  120 ", 0)).toBe(120_000);
  });

  it("parses an HTTP-date relative to now, clamped at zero", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const future = "Thu, 01 Jan 2026 00:00:10 GMT";
    expect(parseRetryAfterMs(future, now)).toBe(10_000);
    const past = "Thu, 01 Jan 2026 00:00:00 GMT";
    expect(parseRetryAfterMs(past, now + 5000)).toBe(0);
  });

  it("returns null for absent or unparseable values", () => {
    expect(parseRetryAfterMs(null, 0)).toBeNull();
    expect(parseRetryAfterMs("", 0)).toBeNull();
    expect(parseRetryAfterMs("soon", 0)).toBeNull();
  });
});

describe("computeBackoffMs", () => {
  it("grows exponentially and caps at maxDelayMs (no jitter)", () => {
    const o = { baseDelayMs: 400, maxDelayMs: 20_000, jitter: false, random: () => 0.5 };
    expect(computeBackoffMs(0, o)).toBe(400);
    expect(computeBackoffMs(1, o)).toBe(800);
    expect(computeBackoffMs(2, o)).toBe(1600);
    // 400 * 2^6 = 25600 -> capped at 20000.
    expect(computeBackoffMs(6, o)).toBe(20_000);
  });

  it("applies full jitter as random * cappedDelay", () => {
    const o = { baseDelayMs: 400, maxDelayMs: 20_000, jitter: true, random: () => 0.25 };
    // attempt 1 -> capped 800, jittered to 0.25 * 800 = 200.
    expect(computeBackoffMs(1, o)).toBe(200);
  });
});

describe("fetchWithRetry", () => {
  it("retries on a retryable status then succeeds, returning the success", async () => {
    const { sleep, delays } = recordingSleep();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValueOnce(makeResponse(500))
      .mockResolvedValueOnce(makeResponse(200));

    const res = await fetchWithRetry("https://example.test/data", {
      retries: 4,
      jitter: false,
      fetchImpl,
      sleep,
    });

    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // Two backoffs slept (after the 503 and the 500), none after the 200.
    expect(delays).toEqual([400, 800]);
  });

  it("retries on a thrown network error then succeeds", async () => {
    const { sleep, delays } = recordingSleep();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(makeResponse(200));

    const res = await fetchWithRetry("https://example.test", {
      jitter: false,
      fetchImpl,
      sleep,
    });

    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([400]);
  });

  it("gives up after N retries and returns the last retryable response", async () => {
    const { sleep, delays } = recordingSleep();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(makeResponse(429));

    const res = await fetchWithRetry("https://example.test", {
      retries: 2, // 3 total attempts
      jitter: false,
      fetchImpl,
      sleep,
    });

    expect(res.status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // Slept after attempt 0 and attempt 1, but NOT after the final attempt 2.
    expect(delays).toEqual([400, 800]);
  });

  it("gives up after N retries and re-throws the last network error", async () => {
    const { sleep, delays } = recordingSleep();
    const boom = new Error("DNS failure");
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(boom);

    await expect(
      fetchWithRetry("https://example.test", {
        retries: 3, // 4 total attempts
        jitter: false,
        fetchImpl,
        sleep,
      }),
    ).rejects.toBe(boom);

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([400, 800, 1600]);
  });

  it("honours a Retry-After header (delta-seconds) over computed backoff", async () => {
    const { sleep, delays } = recordingSleep();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeResponse(429, { "Retry-After": "5" }))
      .mockResolvedValueOnce(makeResponse(200));

    const onRetry = vi.fn();
    const res = await fetchWithRetry("https://example.test", {
      jitter: false,
      fetchImpl,
      sleep,
      onRetry,
    });

    expect(res.status).toBe(200);
    // 5 seconds from the header, NOT the 400ms backoff.
    expect(delays).toEqual([5000]);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ status: 429, delayMs: 5000, fromRetryAfter: true }),
    );
  });

  it("caps a large Retry-After at maxDelayMs", async () => {
    const { sleep, delays } = recordingSleep();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeResponse(503, { "Retry-After": "3600" }))
      .mockResolvedValueOnce(makeResponse(200));

    await fetchWithRetry("https://example.test", {
      maxDelayMs: 20_000,
      jitter: false,
      fetchImpl,
      sleep,
    });

    expect(delays).toEqual([20_000]);
  });

  it("does NOT retry a non-retryable status (e.g. 404)", async () => {
    const { sleep, delays } = recordingSleep();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(makeResponse(404));

    const res = await fetchWithRetry("https://example.test", { fetchImpl, sleep });

    expect(res.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("respects a custom retryOn set", async () => {
    const { sleep } = recordingSleep();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeResponse(418)) // teapot, custom-retryable
      .mockResolvedValueOnce(makeResponse(200));

    const res = await fetchWithRetry("https://example.test", {
      retryOn: [418],
      jitter: false,
      fetchImpl,
      sleep,
    });

    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("never invokes a real timer: sleep stub is a no-op and the test is synchronous-fast", async () => {
    // With retries=4 and a constant 503, real backoff would sleep 400+800+1600+3200ms.
    // The stubbed sleep makes this resolve immediately, proving no real timers are used.
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(makeResponse(503));

    const start = Date.now();
    await fetchWithRetry("https://example.test", {
      retries: 4,
      jitter: false,
      fetchImpl,
      sleep,
    });
    expect(Date.now() - start).toBeLessThan(100);
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it("rejects an invalid retries option", async () => {
    await expect(
      fetchWithRetry("https://example.test", { retries: -1, fetchImpl: vi.fn() }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
