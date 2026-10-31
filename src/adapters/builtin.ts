/** Built-in CRM target: main *is* the CRM, so pushing is a no-op. */
import type { TargetAdapter } from "../core/types";

export const builtinAdapter: TargetAdapter = {
  id: "builtin",
  name: "Git CRM built-in CRM",
  async push(events) {
    return { ok: true, pushed: events.length };
  },
};
