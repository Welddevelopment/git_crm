/** Agent registry (lead-owned). */
import type { CRMAgent } from "../core/types";
import { inboxAgent } from "./inbox";
import { hygieneAgent } from "./hygiene";
import { schemaAgent } from "./schema";
import { webwatchAgent } from "./webwatch";
export const AGENTS: CRMAgent[] = [inboxAgent, hygieneAgent, schemaAgent, webwatchAgent];
export const agentById = (id: string) => AGENTS.find((a) => a.id === id);
