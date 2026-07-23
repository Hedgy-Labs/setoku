// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from "react";

/** Minimal data-fetching hook: { data, error, loading, reload }. */
export function useApi<T>(
  fn: () => Promise<T>,
  deps: unknown[] = [],
): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // The newest run's canceller. Every run supersedes ALL prior in-flight runs —
  // effect-invoked and manual reload() alike — so a slow stale response can
  // never land over a newer one (e.g. an SSE-nudged reload still in flight when
  // the user navigates to another app must not repaint the old app's data).
  // The effect's own cleanup previously cancelled only effect-invoked runs.
  const cancelPrev = useRef<(() => void) | null>(null);
  // The caller controls invalidation via `deps`; fn itself is intentionally not a dep.
  const load = useCallback(fn, deps); // eslint-disable-line react-hooks/exhaustive-deps
  const run = useCallback(() => {
    cancelPrev.current?.();
    let alive = true;
    setLoading(true);
    load()
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    const cancel = () => {
      alive = false;
    };
    cancelPrev.current = cancel;
    return cancel;
  }, [load]);
  useEffect(run, [run]);
  return { data, error, loading, reload: run };
}
