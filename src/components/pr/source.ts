"use client";
/* OWNER: W9. Picks real API vs local mock. Mock is used ONLY with ?mock=1 in the URL, or when the real call fails. */
import { api } from "@/client/api";
import type { PRDetail } from "@/core/api-contract";
import type { PullRequest } from "@/core/types";
import { mockApi } from "./mock";

export type Source = "api" | "mock";

export function forcedMock(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("mock") === "1";
}

/** Keep ?mock=1 on internal links so the demo stays in mock mode while navigating. */
export function withMock(href: string): string {
  if (!forcedMock()) return href;
  return href + (href.includes("?") ? "&" : "?") + "mock=1";
}

async function read<T>(real: () => Promise<T>, mock: () => Promise<T>): Promise<{ data: T; source: Source; error?: string }> {
  if (forcedMock()) return { data: await mock(), source: "mock" };
  try {
    return { data: await real(), source: "api" };
  } catch (e) {
    const msg = errorMessage(e);
    // A 4xx is a real answer from a live backend (e.g. unknown PR) — never paper over it with mock data.
    if (/^4\d\d /.test(msg)) throw e;
    try {
      return { data: await mock(), source: "mock", error: msg };
    } catch {
      throw e;
    }
  }
}

export const prSource = {
  list: () => read<{ prs: PullRequest[] }>(() => api.prs(), () => mockApi.prs()),
  detail: (id: string) => read<PRDetail>(() => api.pr(id), () => mockApi.pr(id)),
  merge: (src: Source, id: string, by: string, resolutions?: Record<string, unknown>) =>
    src === "mock" ? mockApi.merge(id, by, resolutions) : api.merge(id, by, resolutions),
  close: (src: Source, id: string, by: string, reason?: string) => (src === "mock" ? mockApi.close(id, by) : api.close(id, by, reason)),
  revert: (src: Source, id: string, by: string) => (src === "mock" ? mockApi.revert(id, by) : api.revert(id, by)),
  refresh: (src: Source, id: string) => (src === "mock" ? mockApi.refresh(id) : api.refresh(id)),
  subscribe: (src: Source, fn: () => void): (() => void) => (src === "mock" ? () => {} : api.subscribe(fn)),
};

/** Turn `POST /api/x -> 409: {"error":"..."}` into a readable sentence. */
export function errorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const m = raw.match(/->\s*(\d{3}):\s*([\s\S]*)$/);
  if (!m) return raw;
  const [, status, body] = m;
  let text = body.trim();
  try {
    const parsed = JSON.parse(text);
    text = parsed?.error || parsed?.message || (typeof parsed === "string" ? parsed : text);
  } catch {
    /* not json */
  }
  if (/<html|<!doctype/i.test(text)) text = "server returned an HTML error page";
  return `${status} · ${String(text).slice(0, 300)}`;
}
