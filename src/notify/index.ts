import type { Notifier } from "../core/types";
import { consoleNotifier } from "./console";
import { photonConfigured, photonNotifier } from "./photon";

export { consoleNotifier } from "./console";
export { createPhotonNotifier, formatPRMessage, photonNotifier } from "./photon";

/** console always; Photon iMessage when its env vars are set. */
export function getNotifiers(): Notifier[] {
  return photonConfigured() ? [consoleNotifier, photonNotifier] : [consoleNotifier];
}
