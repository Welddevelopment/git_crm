import type { TargetAdapter } from "../core/types";
import { builtinAdapter } from "./builtin";
import { hubspotAdapter } from "./hubspot";

export { builtinAdapter } from "./builtin";
export { createHubSpotAdapter, hubspotAdapter, hubspotProperty } from "./hubspot";

/** builtin always; HubSpot only when HUBSPOT_TOKEN is set. */
export function getAdapters(): TargetAdapter[] {
  return process.env.HUBSPOT_TOKEN ? [builtinAdapter, hubspotAdapter] : [builtinAdapter];
}
