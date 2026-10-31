/** OWNER: agent builder "schema". Must work with NO API key (deterministic fallback) and be better with one. */
import type { CRMAgent } from "../../core/types";
export const schemaAgent: CRMAgent = {
  id: "schema",
  name: "schema",
  description: "TODO",
  async run() { return []; },
};
