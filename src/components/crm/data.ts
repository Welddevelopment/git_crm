"use client";
/**
 * OWNER: W10. Data source for W10 pages: the real `api` (src/client/api.ts), or the local mock
 * when the URL has `?mock=1` or the API is unreachable / not implemented yet.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/client/api";
import { mock } from "./mock";

type Src = Pick<typeof api, "state" | "timeline" | "blame" | "prs" | "fleet" | "runFleet" | "reset" | "inject" | "subscribe">;

let forced: boolean | null = null;
let fellBack = false;
const modeListeners = new Set<() => void>();

export function isMock(): boolean {
  if (forced === null && typeof window !== "undefined") {
    try { forced = new URLSearchParams(window.location.search).get("mock") === "1"; } catch { forced = false; }
  }
  return !!forced || fellBack;
}
function fallBack(err: unknown) {
  if (fellBack || forced) return;
  console.warn("[mainline] API unavailable, using local mock data:", err);
  fellBack = true;
  modeListeners.forEach((f) => f());
}

/** Wrap every call: try the real API; on failure switch to mock for the session (except mutations that reached the server). */
function wrap<K extends keyof Src>(k: K): Src[K] {
  return (async (...args: unknown[]) => {
    if (isMock()) return (mock[k] as (...a: unknown[]) => unknown)(...args);
    try {
      return await (api[k] as (...a: unknown[]) => Promise<unknown>)(...args);
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      // Server reachable but returned a domain error (409 etc.) → surface it, don't flip to mock.
      if (/-> (4\d\d)/.test(msg) && !/-> 404/.test(msg)) throw e;
      fallBack(e);
      return (mock[k] as (...a: unknown[]) => unknown)(...args);
    }
  }) as unknown as Src[K];
}

export const src: Src = {
  state: wrap("state"),
  timeline: wrap("timeline"),
  blame: wrap("blame"),
  prs: wrap("prs"),
  fleet: wrap("fleet"),
  runFleet: wrap("runFleet"),
  reset: wrap("reset"),
  inject: wrap("inject"),
  subscribe(fn) {
    let unsubApi = () => {};
    let unsubMock = () => {};
    const attach = () => {
      unsubApi(); unsubMock();
      if (isMock()) { unsubMock = mock.subscribe(fn); unsubApi = () => {}; }
      else { unsubApi = api.subscribe(fn); }
    };
    attach();
    const onMode = () => { attach(); fn(); };
    modeListeners.add(onMode);
    return () => { unsubApi(); unsubMock(); modeListeners.delete(onMode); };
  },
};

export function useMockFlag(): boolean {
  const [m, setM] = useState(false);
  useEffect(() => {
    setM(isMock());
    const f = () => setM(isMock());
    modeListeners.add(f);
    return () => { modeListeners.delete(f); };
  }, []);
  return m;
}

/**
 * Load data with `loader`, re-run on every server change (SSE), coalesced to at most one refetch per 250ms.
 */
export function useLive<T>(loader: () => Promise<T>, deps: unknown[] = []): { data: T | null; error: string | null; reload: () => void; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const ref = useRef(loader);
  ref.current = loader;
  const inflight = useRef(false);
  const pending = useRef(false);
  const run = useCallback(async () => {
    if (inflight.current) { pending.current = true; return; }
    inflight.current = true;
    setLoading(true);
    try { setData(await ref.current()); setError(null); }
    catch (e) { setError(String((e as Error)?.message || e)); }
    finally {
      inflight.current = false; setLoading(false);
      if (pending.current) { pending.current = false; setTimeout(run, 0); }
    }
  }, []);
  useEffect(() => {
    run();
    let t: ReturnType<typeof setTimeout> | null = null;
    const unsub = src.subscribe(() => { if (t) return; t = setTimeout(() => { t = null; run(); }, 250); });
    return () => { unsub(); if (t) clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, reload: run, loading };
}
