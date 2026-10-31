/** OWNER: agent builder "inbox". Must work with NO API key (deterministic fallback) and be better with one. */
import type { CRMAgent } from "../../core/types";
export const inboxAgent: CRMAgent = {
  id: "inbox",
  name: "inbox",
  description: "TODO",
  async run() { return []; },
};
