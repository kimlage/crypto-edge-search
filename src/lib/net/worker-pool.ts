/**
 * Bounded-concurrency `map` over an array, with per-item error isolation.
 *
 * When fanning out N requests (e.g. one fetch per symbol, one backtest per parameter
 * set), running them all at once overwhelms the remote endpoint and the local event
 * loop, while running them strictly one-at-a-time wastes wall-clock on I/O waits. This
 * runs at most `concurrency` workers in flight at any instant, pulling the next input as
 * soon as a slot frees up.
 *
 * Two guarantees the naive `Promise.all(items.map(worker))` does NOT give you:
 *
 *   1. ORDER PRESERVATION. Results are written back to the index the input came from, so
 *      `results[i]` always corresponds to `items[i]`, regardless of completion order.
 *
 *   2. ERROR ISOLATION. A worker that throws for one item does NOT abort the batch; its
 *      failure is collected into `errors` (keyed by index) and the remaining items still
 *      run to completion. The caller decides how to treat partial failure.
 *
 * For an item that failed, `results[i]` is left `undefined` and an entry appears in
 * `errors`. For an item that succeeded, no `errors` entry exists. This separation lets a
 * caller distinguish "worker returned undefined" from "worker threw" by checking `errors`.
 *
 * Concurrency is enforced by a fixed pool of `concurrency` async "runner" loops that each
 * pull from a shared cursor; at no point are more than `concurrency` worker invocations
 * pending. The function is otherwise pure aside from whatever side effects the injected
 * `worker` performs.
 */

/** Options for {@link mapWithConcurrency}. */
export interface MapWithConcurrencyOptions {
  /** Maximum number of `worker` invocations in flight at once. Must be a positive integer. */
  concurrency: number;
  /**
   * Optional progress callback, invoked after EACH item settles (success or failure),
   * with the running count of settled items and the total. Useful for progress bars.
   */
  onProgress?: (progress: ProgressInfo) => void;
}

/** Snapshot of progress passed to the optional `onProgress` callback. */
export interface ProgressInfo {
  /** Number of items that have settled (resolved or rejected) so far. */
  completed: number;
  /** Total number of input items. */
  total: number;
}

/** One captured per-item failure. */
export interface ItemError {
  /** The index in the input array whose worker threw. */
  index: number;
  /** The thrown value (whatever the worker rejected/threw with). */
  error: unknown;
}

/** The outcome of a {@link mapWithConcurrency} run. */
export interface MapWithConcurrencyResult<R> {
  /**
   * Results aligned to the INPUT order. `results[i]` is the value `worker` returned for
   * `items[i]`, or `undefined` if that item's worker threw (see {@link errors}).
   */
  results: (R | undefined)[];
  /** One entry per item whose worker threw, in ascending index order. */
  errors: ItemError[];
}

/**
 * Run `worker` over every element of `items` with at most `concurrency` invocations in
 * flight, preserving input order in `results` and collecting per-item failures in
 * `errors` without aborting the batch.
 *
 * @param items   The inputs to process. Not mutated.
 * @param worker  Async (or sync) function mapping `(item, index) -> result`. May throw.
 * @param options Concurrency cap and optional progress callback.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => R | Promise<R>,
  options: MapWithConcurrencyOptions,
): Promise<MapWithConcurrencyResult<R>> {
  const { concurrency, onProgress } = options;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${String(concurrency)}`);
  }

  const total = items.length;
  const results: (R | undefined)[] = new Array(total).fill(undefined);
  const errors: ItemError[] = [];

  if (total === 0) {
    return { results, errors };
  }

  let cursor = 0; // index of the next item to claim
  let completed = 0;

  // Each runner loops, claiming the next unprocessed index until the inputs are
  // exhausted. With `poolSize` runners, at most `poolSize` worker calls are ever pending.
  const runner = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      if (index >= total) return;
      cursor++;

      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        errors.push({ index, error });
      } finally {
        completed++;
        onProgress?.({ completed, total });
      }
    }
  };

  const poolSize = Math.min(concurrency, total);
  await Promise.all(Array.from({ length: poolSize }, () => runner()));

  // Surface errors in ascending index order for a stable, predictable contract.
  errors.sort((a, b) => a.index - b.index);

  return { results, errors };
}
