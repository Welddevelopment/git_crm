export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { getRepo } from "@/server/repo";

const HEARTBEAT_MS = 15_000;

export async function GET(req: Request): Promise<Response> {
  const repo = await getRepo();
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (s: string) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(s)); } catch { cleanup(); }
      };
      const unsubscribe = repo.deps.store.subscribe((change) => {
        send(`data: ${JSON.stringify({ kind: change.kind, key: change.key })}\n\n`);
      });
      const hb = setInterval(() => send(`: heartbeat ${Date.now()}\n\n`), HEARTBEAT_MS);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(hb);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener("abort", () => cleanup(), { once: true });
      send(`retry: 2000\n\n`);
      send(`data: ${JSON.stringify({ kind: "hello" })}\n\n`);
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
