"use client";
/** OWNER: settings worker. Small helpers shared by the settings sections. */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/client/api";

export class HttpError extends Error {
  constructor(public status: number, public body: unknown, msg: string) {
    super(msg);
  }
}

/** JSON fetch for routes the lead client doesn't wrap yet (integrations, proxy). Never throws on parse. */
export async function http<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) }, cache: "no-store" });
  const text = await r.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!r.ok) {
    const msg = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : typeof body === "string" ? body.slice(0, 300) : `HTTP ${r.status}`;
    throw new HttpError(r.status, body, `${init?.method || "GET"} ${path} -> ${r.status}: ${msg}`);
  }
  return body as T;
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Load once, then refetch on every server change (SSE), debounced. `paused` skips refetches (e.g. unsaved edits). */
export function useLive<T>(load: () => Promise<T>, opts: { paused?: boolean } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const pausedRef = useRef(!!opts.paused);
  pausedRef.current = !!opts.paused;

  const reload = useCallback(async () => {
    try {
      const d = await loadRef.current();
      setData(d);
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    let t: ReturnType<typeof setTimeout> | undefined;
    const unsub = api.subscribe(() => {
      if (pausedRef.current) return;
      clearTimeout(t);
      t = setTimeout(() => void reload(), 250);
    });
    return () => { clearTimeout(t); unsub(); };
  }, [reload]);

  return { data, error, loading, reload, setData };
}

export function fmtAgo(ts: number | null | undefined): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
