/**
 * Runs once when the Next.js server starts.
 * Railway's free plan sleeps a service after ~10 min without outbound traffic, and Git CRM keeps
 * state in memory — so we ping our own public URL every 4 minutes to keep the demo world alive.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const host = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.MAINLINE_KEEPALIVE_HOST;
  if (!host || process.env.MAINLINE_KEEPALIVE === "off") return;
  const g = globalThis as unknown as { __mainlineKeepalive?: ReturnType<typeof setInterval> };
  if (g.__mainlineKeepalive) return;
  const ping = () => {
    fetch(`https://${host}/api/fleet`, { cache: "no-store" }).catch(() => {});
  };
  setTimeout(ping, 15_000); // warm the repo (seed) shortly after boot
  g.__mainlineKeepalive = setInterval(ping, 4 * 60_000);
}
