export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { getRepo } from "@/server/repo";
import { fleetStatus } from "@/server/fleet";
import { handle, json } from "@/server/http";

export const GET = handle(async () => json(await fleetStatus(await getRepo())));
