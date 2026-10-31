/** OWNER: W7. LLM helper shared by all agents. Never throws; returns null when no key / any failure. */
import Anthropic from "@anthropic-ai/sdk";
import type { AgentContext } from "../core/types";

const DEFAULT_MODEL = "claude-sonnet-4-5";
const TIMEOUT_MS = 20_000;

let client: Anthropic | null = null;
let clientKey: string | undefined;
function getClient(apiKey: string): Anthropic {
  if (!client || clientKey !== apiKey) {
    client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 0 });
    clientKey = apiKey;
  }
  return client;
}

/** Claude call via @anthropic-ai/sdk; returns null when ANTHROPIC_API_KEY is missing or the call fails. Model from env MAINLINE_MODEL. */
export function makeLLM(): AgentContext["llm"] {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return async () => null;
  return async ({ system, prompt, maxTokens }) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const anthropic = getClient(apiKey);
      const call = anthropic.messages.create({
        model: process.env.MAINLINE_MODEL || DEFAULT_MODEL,
        max_tokens: maxTokens ?? 1024,
        system,
        messages: [{ role: "user", content: prompt }],
      });
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), TIMEOUT_MS);
      });
      const res = await Promise.race([call, timeout]);
      if (!res) {
        call.catch(() => {}); // swallow late rejection
        return null;
      }
      const text = res.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      return text.length ? text : null;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/**
 * Pull a JSON value out of an LLM reply: strips ```json fences, then parses the first balanced {...} or [...].
 * Returns null if nothing parses.
 */
export function extractJSON<T = unknown>(text: string | null | undefined): T | null {
  if (!text) return null;
  const candidates: string[] = [];
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) candidates.push(m[1]);
  candidates.push(text);
  for (const c of candidates) {
    const trimmed = c.trim();
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      /* fall through to scan */
    }
    const found = firstBalanced(trimmed);
    if (found !== null) return found as T;
  }
  return null;
}

/** Scan for the first balanced {...} or [...] that JSON.parses. String-aware. */
function firstBalanced(s: string): unknown | null {
  for (let start = 0; start < s.length; start++) {
    const open = s[start];
    if (open !== "{" && open !== "[") continue;
    const stack: string[] = [];
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
      else if (ch === "}" || ch === "]") {
        if (stack.pop() !== ch) break;
        if (stack.length === 0) {
          try {
            return JSON.parse(s.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}
