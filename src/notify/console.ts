import type { Notifier } from "../core/types";

export const consoleNotifier: Notifier = {
  id: "console",
  async notify(pr, summary) {
    console.log(`[mainline:notify] ${pr.id} (${pr.status}) "${pr.title}" — ${summary}`);
  },
};
