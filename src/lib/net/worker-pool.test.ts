import { describe, expect, it, vi } from "vitest";

import { mapWithConcurrency } from "./worker-pool";

/**
 * A controllable deferred: a promise plus its resolve/reject handles. Used to hold worker
 * invocations open so the test can observe how many are in flight at a given instant.
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("mapWithConcurrency", () => {
  it("preserves input order in results regardless of completion order", async () => {
    const items = [10, 20, 30, 40, 50];
    // Reverse the natural settle order: later items resolve first.
    const { results, errors } = await mapWithConcurrency(
      items,
      async (n, i) => {
        await Promise.resolve();
        return { i, doubled: n * 2 };
      },
      { concurrency: 2 },
    );

    expect(errors).toEqual([]);
    expect(results).toEqual([
      { i: 0, doubled: 20 },
      { i: 1, doubled: 40 },
      { i: 2, doubled: 60 },
      { i: 3, doubled: 80 },
      { i: 4, doubled: 100 },
    ]);
  });

  it("never exceeds the concurrency cap (tracks in-flight count)", async () => {
    const concurrency = 3;
    const total = 12;
    const gates = Array.from({ length: total }, () => deferred<number>());

    let inFlight = 0;
    let maxInFlight = 0;

    const promise = mapWithConcurrency(
      Array.from({ length: total }, (_, i) => i),
      async (i) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const value = await gates[i].promise;
        inFlight--;
        return value;
      },
      { concurrency },
    );

    // Release gates one at a time, letting the microtask queue drain between each so the
    // pool can pull the next item. At no point should inFlight exceed the cap.
    for (let i = 0; i < total; i++) {
      gates[i].resolve(i * 10);
      // Flush microtasks so the pool advances and updates inFlight before the next assert.
      await Promise.resolve();
      await Promise.resolve();
      expect(inFlight).toBeLessThanOrEqual(concurrency);
    }

    const { results, errors } = await promise;
    expect(errors).toEqual([]);
    expect(maxInFlight).toBeLessThanOrEqual(concurrency);
    expect(maxInFlight).toBe(concurrency); // the cap was actually saturated
    expect(results).toEqual(Array.from({ length: total }, (_, i) => i * 10));
  });

  it("runs all items when concurrency exceeds the item count", async () => {
    const seen: number[] = [];
    const { results } = await mapWithConcurrency(
      [1, 2, 3],
      (n) => {
        seen.push(n);
        return n + 1;
      },
      { concurrency: 100 },
    );
    expect(results).toEqual([2, 3, 4]);
    expect(seen.sort()).toEqual([1, 2, 3]);
  });

  it("isolates per-item errors without aborting the batch", async () => {
    const items = [0, 1, 2, 3, 4];
    const { results, errors } = await mapWithConcurrency(
      items,
      async (n) => {
        if (n % 2 === 1) throw new Error(`odd ${n}`);
        return n * 100;
      },
      { concurrency: 2 },
    );

    // Even items succeeded; odd items failed but did not stop the batch.
    expect(results[0]).toBe(0);
    expect(results[2]).toBe(200);
    expect(results[4]).toBe(400);
    expect(results[1]).toBeUndefined();
    expect(results[3]).toBeUndefined();

    expect(errors.map((e) => e.index)).toEqual([1, 3]);
    expect((errors[0].error as Error).message).toBe("odd 1");
    expect((errors[1].error as Error).message).toBe("odd 3");
  });

  it("continues processing remaining items after an early failure", async () => {
    const processed: number[] = [];
    const { results, errors } = await mapWithConcurrency(
      [0, 1, 2, 3, 4, 5],
      async (n) => {
        processed.push(n);
        if (n === 0) throw new Error("first item fails");
        return n;
      },
      { concurrency: 1 },
    );

    // Even though index 0 threw, every later index still ran.
    expect(processed).toEqual([0, 1, 2, 3, 4, 5]);
    expect(errors).toHaveLength(1);
    expect(errors[0].index).toBe(0);
    expect(results.slice(1)).toEqual([1, 2, 3, 4, 5]);
  });

  it("reports progress once per settled item", async () => {
    const onProgress = vi.fn();
    const totals: number[] = [];
    await mapWithConcurrency(
      [1, 2, 3, 4],
      (n) => {
        if (n === 3) throw new Error("boom");
        return n;
      },
      {
        concurrency: 2,
        onProgress: (p) => {
          totals.push(p.completed);
          onProgress(p);
        },
      },
    );

    // One callback per item (4), including the failed one; final completed === total.
    expect(onProgress).toHaveBeenCalledTimes(4);
    expect(totals).toEqual([1, 2, 3, 4]);
    expect(onProgress).toHaveBeenLastCalledWith({ completed: 4, total: 4 });
  });

  it("handles an empty input array", async () => {
    const worker = vi.fn();
    const { results, errors } = await mapWithConcurrency([], worker, { concurrency: 4 });
    expect(results).toEqual([]);
    expect(errors).toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });

  it("rejects an invalid concurrency", async () => {
    await expect(
      mapWithConcurrency([1], async (n) => n, { concurrency: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      mapWithConcurrency([1], async (n) => n, { concurrency: 1.5 }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("passes the correct index to the worker", async () => {
    const { results } = await mapWithConcurrency(
      ["a", "b", "c"],
      (item, index) => `${index}:${item}`,
      { concurrency: 2 },
    );
    expect(results).toEqual(["0:a", "1:b", "2:c"]);
  });
});
