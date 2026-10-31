/** OWNER: W6. Small helpers shared by every API route. */
import type { Actor } from "../core/types";

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export function errorResponse(e: unknown): Response {
  const status = typeof (e as { status?: unknown })?.status === "number" ? (e as { status: number }).status : 500;
  const message = e instanceof Error ? e.message : String(e);
  if (status >= 500) console.error("[mainline] api error:", e);
  const details = (e as { details?: unknown })?.details;
  return json(details === undefined ? { error: message } : { error: message, details }, status);
}

/** Wrap a handler so thrown errors become `{error}` JSON with the right status. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export async function readBody<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    const text = await req.text();
    if (!text.trim()) return {} as T;
    const v = JSON.parse(text);
    return (v && typeof v === "object" ? v : {}) as T;
  } catch {
    throw Object.assign(new Error("invalid JSON body"), { status: 400 });
  }
}

/** Body `by` is a free-form string from the UI ("Joel"); everything else is a human. */
export function actorFrom(by: unknown): Actor {
  const s = typeof by === "string" && by.trim() ? by.trim() : "human";
  return { kind: "human", id: s, name: s };
}
