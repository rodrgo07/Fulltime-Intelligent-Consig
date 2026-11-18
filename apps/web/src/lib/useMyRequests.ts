import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiError } from "@fic/contracts";
import type { Api, RequestWithResult } from "./api";
import { readSeen, writeSeen } from "./seenResults";

export type MyRequests = ReturnType<typeof useMyRequests>;

/**
 * Solicitações do operador (Realtime + reconsulta a cada 30 s) e propostas geradas ainda não vistas.
 * Fica no App: o contador aparece no menu e no título em qualquer página, e o aviso é anunciado mesmo fora da lista.
 */
export function useMyRequests(api: Api, uid: string | null) {
  const [rows, setRows] = useState<RequestWithResult[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [seen, setSeen] = useState<Set<string> | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const announced = useRef<Set<string> | null>(null);

  const reload = useCallback(async () => {
    if (!uid) return;
    setRefreshing(true);
    const r = await api.myRequests();
    if (r.ok) {
      // Base do anúncio: o que já estava concluído na 1ª carga da sessão não é anunciado.
      if (announced.current === null) {
        announced.current = new Set(r.data.filter((x) => x.status === "completed").map((x) => x.id));
      }
      setRows(r.data);
      setError(null);
      setUpdatedAt(new Date());
    } else setError(r.error);
    setRefreshing(false);
  }, [api, uid]);

  useEffect(() => {
    if (!uid) return;
    setSeen(readSeen(uid));
    announced.current = null;
    void reload();
    const unsub = api.subscribeMyRequests(() => void reload());
    // Reconsulta periódica: não depende só do Realtime.
    const t = window.setInterval(() => void reload(), 30_000);
    return () => {
      unsub();
      window.clearInterval(t);
    };
  }, [api, uid, reload]);

  const completed = useMemo(() => (rows ?? []).filter((r) => r.status === "completed"), [rows]);

  // Primeiro acesso neste navegador: o que já estava concluído conta como visto (sem enxurrada de selos).
  useEffect(() => {
    if (!uid || rows === null || seen !== null) return;
    const initial = new Set(completed.map((r) => r.id));
    writeSeen(uid, initial);
    setSeen(initial);
  }, [uid, rows, seen, completed]);

  const fresh = useMemo(
    () => (seen === null ? [] : completed.filter((r) => !seen.has(r.id))),
    [completed, seen],
  );
  const newIds = useMemo(() => new Set(fresh.map((r) => r.id)), [fresh]);

  // Anúncio (aria-live) só do que virou "Nova" durante a sessão (base definida na 1ª carga, em reload).
  useEffect(() => {
    const base = announced.current;
    if (!base) return;
    const added = fresh.filter((r) => !base.has(r.id));
    added.forEach((r) => base.add(r.id));
    if (added.length) setAnnouncement(`Proposta gerada: ${added.map((r) => r.public_ref).join(", ")}`);
  }, [fresh]);

  const persist = useCallback((next: Set<string>) => {
    if (!uid) return;
    // Só guarda ids ainda listados: a lista não cresce sem limite.
    const listed = new Set((rows ?? []).map((r) => r.id));
    const pruned = new Set([...next].filter((id) => listed.has(id)));
    writeSeen(uid, pruned);
    setSeen(pruned);
  }, [uid, rows]);

  const markSeen = useCallback((id: string) => persist(new Set([...(seen ?? []), id])), [persist, seen]);
  const markAllSeen = useCallback(() => persist(new Set([...(seen ?? []), ...newIds])), [persist, seen, newIds]);

  return { rows, error, refreshing, updatedAt, reload, newIds, newCount: newIds.size, markSeen, markAllSeen, announcement };
}
