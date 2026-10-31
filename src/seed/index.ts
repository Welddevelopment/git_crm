/** OWNER: W8 (seed world + demo scenario). Signatures are contract. */
import type { EvidenceDoc, NewEvent } from "../core/types";
/** Initial main log: schema + ~10 companies, ~25 contacts, ~10 deals. Actor = {kind:"system", id:"seed"}. */
export function seedMainEvents(): NewEvent[] { return []; }
/** Inbox the agents read: ~30 emails over the past 2 weeks. */
export function seedInbox(): EvidenceDoc[] { return []; }
/** Web snapshots the webwatch agent reads (careers/pricing/changelog pages). */
export function seedWeb(): EvidenceDoc[] { return []; }
/** Docs held back and injected live during the demo (e.g. "Acme is pausing the project"). */
export function injectableDocs(): EvidenceDoc[] { return []; }
