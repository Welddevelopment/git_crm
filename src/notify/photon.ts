/**
 * iMessage notifier via Photon (stretch). Generic JSON POST {to, text} to PHOTON_ENDPOINT with
 * Bearer PHOTON_API_KEY. No-op unless PHOTON_API_KEY, PHOTON_TO and PHOTON_ENDPOINT are all set.
 */
import type { Notifier, PullRequest } from "../core/types";

export function formatPRMessage(pr: PullRequest, summary?: string): string {
  const agent = ("name" in pr.author && pr.author.name) || pr.author.id;
  const num = pr.id.replace(/^pr_/, "");
  const reasons = pr.policy?.reasons?.length ? pr.policy.reasons.join("; ") : summary || "needs review";
  return `Git CRM: ${agent} opened PR #${num} "${pr.title}" — ${reasons}. Reply Y to merge, N to close.`;
}

export interface PhotonOptions {
  apiKey?: string;
  to?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

export function photonConfigured(): boolean {
  return Boolean(process.env.PHOTON_API_KEY && process.env.PHOTON_TO && process.env.PHOTON_ENDPOINT);
}

export function createPhotonNotifier(opts: PhotonOptions = {}): Notifier {
  return {
    id: "photon",
    async notify(pr, summary) {
      const apiKey = opts.apiKey ?? process.env.PHOTON_API_KEY;
      const to = opts.to ?? process.env.PHOTON_TO;
      const endpoint = opts.endpoint ?? process.env.PHOTON_ENDPOINT;
      if (!apiKey || !to || !endpoint) return;
      const doFetch = opts.fetchImpl ?? fetch;
      try {
        const res = await doFetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ to, text: formatPRMessage(pr, summary) }),
        });
        if (!res.ok) console.warn(`[mainline:photon] HTTP ${res.status}`);
      } catch (err) {
        console.warn(`[mainline:photon] send failed: ${(err as Error).message}`);
      }
    },
  };
}

export const photonNotifier: Notifier = createPhotonNotifier();
