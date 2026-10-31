import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const post = (body: unknown) => POST(new Request("http://localhost/api/accounts/watch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/accounts/watch", () => {
  it("400 on missing / non-http URL", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
    for (const url of [undefined, "", "ftp://x.com", "javascript:alert(1)", "localhost", 42]) {
      const res = await post({ url });
      expect(res.status).toBe(400);
    }
  });

  it("400 with a clear message when FIRECRAWL_API_KEY is not set (no network)", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const res = await post({ url: "https://example.com" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "FIRECRAWL_API_KEY not set on the server" });
    expect(f).not.toHaveBeenCalled();
  });

  it("502 when nothing could be scraped", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const res = await post({ url: "example.com" });
    expect(res.status).toBe(502);
  });
});
