import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError } from "@fic/contracts";
import type { Result } from "./api";

/** Consulta periódica com recarga manual. Mantém o último dado bom enquanto uma falha temporária durar. */
export function usePoll<T>(load: () => Promise<Result<T>>, everyMs: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    const r = await loadRef.current();
    if (r.ok) {
      setData(r.data);
      setError(null);
    } else {
      setError(r.error);
    }
  }, []);

  useEffect(() => {
    void reload();
    const t = window.setInterval(() => void reload(), everyMs);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everyMs, reload, ...deps]);

  return { data, error, reload };
}
