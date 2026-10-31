import type { TargetAdapter } from "../core/types";
import { builtinAdapter } from "./builtin";
import { hubspotAdapter } from "./hubspot";
import { getAttioAdapter } from "./attio";

export { builtinAdapter } from "./builtin";
export { createHubSpotAdapter, hubspotAdapter, hubspotProperty } from "./hubspot";

/** builtin always; HubSpot / Attio only when their tokens are set. */
export function getAdapters(): TargetAdapter[] {
  const out: TargetAdapter[] = [builtinAdapter];
  if (process.env.HUBSPOT_TOKEN) out.push(hubspotAdapter);
  if (process.env.ATTIO_TOKEN) out.push(getAttioAdapter());
  return out;
}
