// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState } from "react";

/** Minimal data-fetching hook: { data, error, loading, reload }. */
export function useApi<T>(
  fn: () => Promise<T>,
  deps: unknown[] = [],
): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // The caller controls invalidation via `deps`; fn itself is intentionally not a dep.
  const load = useCallback(fn, deps); // eslint-disable-line react-hooks/exhaustive-deps
  const run = useCallback(() => {
    let alive = true;
    setLoading(true);
    load()
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [load]);
  useEffect(run, [run]);
  return { data, error, loading, reload: run };
}
