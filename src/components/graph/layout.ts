/** OWNER: graph worker. Pure layout for the branch graph: columns (compressed history), lanes (greedy interval packing). */
import type { GraphBranch, GraphData, GraphMainNode } from "./types";

export interface LayoutOpts { width: number; height: number; compact: boolean }

export type ChipKind = "stale" | "conflict" | "outdated" | "block" | "auto" | "review" | "closed";
export interface Chip { kind: ChipKind; text: string; w: number }

export interface MainPos { node: GraphMainNode; x: number; r: number; recent: boolean }
export interface BranchPos {
  b: GraphBranch;
  lane: number;
  y: number;
  forkX: number;
  headX: number;
  mergeX?: number;
  forkPath: string; // fork curve + run to head
  endPath?: string; // merge (or revert) curve back to main
  tailPath?: string; // dashed tail for open/closed
  label: string;
  labelX: number;
  labelW: number;
  chip?: Chip;
  chipX: number;
  end: number;
}
export interface Tick { x: number; text: string }
export interface Layout {
  width: number;
  height: number;
  mainY: number;
  mainStart: number;
  mainEnd: number;
  main: MainPos[];
  branches: BranchPos[];
  lanes: number;
  ticks: Tick[];
  divider?: { x: number; label: string };
  historyLabelX?: number;
}

const CH = 6.3; // approx advance of 10.5px mono
export const textW = (s: string, ch = CH) => Math.ceil(s.length * ch);

export function shortLabel(b: GraphBranch): string {
  const num = `#${b.pr.replace(/^pr_/, "")}`;
  let t = b.title.replace(/\s*→\s*/g, "→").replace(/\s+/g, " ").trim();
  const money = t.match(/\$[\d.,]+[kKmM]?→\$[\d.,]+[kKmM]?/);
  const dash = t.indexOf(" — ");
  if (dash > 0) {
    const who = t.slice(0, dash);
    const rest = t.slice(dash + 3);
    const what = money ? money[0] : rest.includes(": ") ? rest.slice(rest.indexOf(": ") + 2) : rest;
    t = `${who} — ${what}`;
  } else {
    t = t
      .replace(/^Merge duplicate (\w+): /i, "dedup ")
      .replace(/^Schema: /i, "schema: ")
      .replace(/^Normalize /i, "normalize ");
  }
  const max = 30;
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + "…";
  return `${num} ${t}`;
}

export function chipFor(b: GraphBranch): Chip | undefined {
  let kind: ChipKind | undefined;
  let text = "";
  if (b.status === "closed") { kind = "closed"; text = "closed"; }
  else if (b.status !== "open") return undefined;
  else if (b.stale) { kind = "stale"; text = "● stale"; }
  else if (b.conflicts > 0) { kind = "conflict"; text = `⚠ ${b.conflicts} conflict${b.conflicts > 1 ? "s" : ""}`; }
  else if (b.versionConflict) { kind = "outdated"; text = "⚠ main moved"; }
  else if (b.tier === "block") { kind = "block"; text = "blocked"; }
  else if (b.tier === "auto") { kind = "auto"; text = "✓ auto"; }
  else { kind = "review"; text = "needs review"; }
  return { kind, text, w: textW(text, 6.1) + 14 };
}

function nodeContaining(main: GraphMainNode[], seq: number): number {
  for (let i = 0; i < main.length; i++) if (seq >= main[i]!.firstSeq && seq <= main[i]!.seq) return i;
  if (main.length && seq > main[main.length - 1]!.seq) return main.length - 1;
  return -1; // before visible history
}

const fmtDay = (ts: number) => new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

export function layout(data: GraphData, o: LayoutOpts): Layout {
  const { compact } = o;
  const mainY = compact ? 16 : 30;
  const left = compact ? 14 : 58;
  const reserve = compact ? 56 : 300;

  // ---- slots: main commits + branch heads, ordered by time ----
  type Slot = { ts: number; kind: "main" | "head"; idx: number };
  const slots: Slot[] = [
    ...data.main.map((n, idx) => ({ ts: n.ts, kind: "main" as const, idx })),
    ...data.branches.map((b, idx) => ({ ts: b.createdAt, kind: "head" as const, idx })),
  ];
  slots.sort((a, b) => a.ts - b.ts || (a.kind === b.kind ? a.idx - b.idx : a.kind === "main" ? -1 : 1));

  // era split: "live session" = since shortly before the first PR (or the last 3h)
  const firstPR = data.branches.length ? Math.min(...data.branches.map((b) => b.createdAt)) : Infinity;
  const sessionStart = Math.min(firstPR - 10 * 60_000, data.now - 3 * 3600_000);
  const isRecent = (ts: number) => ts >= sessionStart;
  const H = slots.filter((s) => !isRecent(s.ts)).length;
  const R = slots.length - H;

  const inner = Math.max(200, o.width - left - reserve);
  const xs: number[] = [];
  let divider: Layout["divider"];
  let historyLabelX: number | undefined;
  if (R === 0) {
    const step = H > 1 ? Math.min(compact ? 40 : 120, (inner + reserve - (compact ? 20 : 70)) / (H - 1)) : 0;
    slots.forEach((_, i) => xs.push(left + i * step));
  } else {
    const gap = H ? (compact ? 14 : 34) : 0;
    const histW = H > 1 ? Math.min((H - 1) * (compact ? 7 : 18), inner * 0.25) : 0;
    const hStep = H > 1 ? histW / (H - 1) : 0;
    const rStep = R > 1 ? Math.max(compact ? 8 : 22, Math.min(compact ? 26 : 74, (inner - histW - gap) / (R - 1))) : 0;
    let x = left;
    slots.forEach((s, i) => {
      if (i > 0) x += i === H ? gap : i < H ? hStep : rStep;
      xs.push(x);
    });
    if (H) {
      divider = { x: left + histW + gap / 2, label: `live · since ${fmtTime(slots[H]!.ts)}` };
      historyLabelX = left;
    }
  }

  const mainX: number[] = new Array(data.main.length).fill(left);
  const headX: number[] = new Array(data.branches.length).fill(left);
  slots.forEach((s, i) => { if (s.kind === "main") mainX[s.idx] = xs[i]!; else headX[s.idx] = xs[i]!; });

  const main: MainPos[] = data.main.map((node, i) => ({
    node, x: mainX[i]!, recent: isRecent(node.ts),
    r: (compact ? 2.6 : 4) + Math.min(compact ? 1.6 : 3, Math.log2(node.count) * (compact ? 0.4 : 0.7)),
  }));

  // ---- branch geometry (y filled in after lane packing) ----
  const lastSlotX = xs.length ? xs[xs.length - 1]! : left;
  type Pre = Omit<BranchPos, "lane" | "y" | "forkPath" | "endPath" | "tailPath"> & { start: number; mergeTo?: number };
  const pre: Pre[] = data.branches.map((b, i) => {
    const hx = headX[i]!;
    const fi = nodeContaining(data.main, b.forkSeq);
    let forkX = fi >= 0 ? mainX[fi]! : left - (compact ? 6 : 14);
    if (forkX > hx - 8) forkX = Math.max(left - 14, hx - 8);
    let mergeX: number | undefined;
    if (b.status === "merged" || b.status === "reverted") {
      const mi = b.mergeSeq !== undefined ? nodeContaining(data.main, b.mergeSeq) : -1;
      mergeX = mi >= 0 ? mainX[mi]! : b.mergedAt ? (main.find((m) => m.node.ts >= b.mergedAt!)?.x ?? lastSlotX) : lastSlotX;
      if (mergeX < hx + 10) mergeX = hx + 10;
    }
    const label = compact ? "" : shortLabel(b);
    const labelX = hx + 10;
    const labelW = compact ? 0 : textW(label) + 12;
    const chip = chipFor(b);
    const tailLen = compact ? 22 : 16;
    const chipX = compact ? hx + tailLen : labelX + labelW + tailLen;
    let end: number;
    if (mergeX !== undefined) end = Math.max(mergeX, labelX + labelW) + (compact ? 6 : 14);
    else end = chipX + (chip ? (compact ? 6 : chip.w) : 0) + (compact ? 6 : 14);
    const p: Pre = { b, forkX, headX: hx, label, labelX, labelW, chipX, end, start: forkX - 2 };
    if (chip) p.chip = chip;
    if (mergeX !== undefined) p.mergeX = mergeX;
    return p;
  });

  // open/closed tails all end in one aligned chip column ("now")
  const pending = pre.filter((p) => p.mergeX === undefined);
  if (pending.length) {
    const col = Math.max(...pending.map((p) => (compact ? p.headX + 18 : p.labelX + p.labelW + 18)));
    for (const p of pending) {
      p.chipX = col;
      p.end = col + (p.chip ? (compact ? 6 : p.chip.w) : 0) + (compact ? 6 : 14);
    }
  }

  // ---- greedy interval packing into lanes ----
  const order = pre.map((_, i) => i).sort((a, b) => pre[a]!.start - pre[b]!.start || pre[a]!.b.createdAt - pre[b]!.b.createdAt);
  const laneEnd: number[] = [];
  const laneOf: number[] = new Array(pre.length).fill(0);
  for (const i of order) {
    const p = pre[i]!;
    let lane = laneEnd.findIndex((e) => e <= p.start);
    if (lane < 0) { lane = laneEnd.length; laneEnd.push(p.end); } else laneEnd[lane] = p.end;
    laneOf[i] = lane;
  }
  const lanes = laneEnd.length;
  const bottomPad = compact ? 10 : 22;
  const firstGap = compact ? 16 : 30;
  const avail = o.height - mainY - firstGap - bottomPad;
  const laneGap = lanes > 1 ? Math.max(compact ? 8 : 17, Math.min(compact ? 14 : 30, avail / (lanes - 1))) : 0;
  const laneY = (l: number) => mainY + firstGap + l * laneGap;
  const height = Math.max(o.height, lanes ? laneY(lanes - 1) + bottomPad : 0);

  const branches: BranchPos[] = pre.map((p, i) => {
    const lane = laneOf[i]!;
    const y = laneY(lane);
    const dy = y - mainY;
    const cw = Math.max(8, Math.min(compact ? 22 : 40, p.headX - p.forkX, 18 + dy * 0.35));
    const fx = p.forkX;
    const forkPath = `M${fx},${mainY} C${fx + cw * 0.55},${mainY} ${fx + cw * 0.45},${y} ${fx + cw},${y} L${p.headX},${y}`;
    const out: BranchPos = {
      b: p.b, lane, y, forkX: p.forkX, headX: p.headX, label: p.label, labelX: p.labelX, labelW: p.labelW,
      chipX: p.chipX, end: p.end, forkPath,
    };
    if (p.chip) out.chip = p.chip;
    if (p.mergeX !== undefined) {
      const mx = p.mergeX;
      const mw = Math.max(8, Math.min(compact ? 22 : 40, mx - p.headX, 18 + dy * 0.35));
      out.mergeX = mx;
      out.endPath = `M${p.headX},${y} L${mx - mw},${y} C${mx - mw * 0.45},${y} ${mx - mw * 0.55},${mainY} ${mx},${mainY}`;
    } else {
      const from = compact ? p.headX + 4 : p.labelX + p.labelW + 3;
      out.tailPath = `M${from},${y} L${p.chipX - 3},${y}`;
    }
    return out;
  });

  // ---- ticks (above main) ----
  const ticks: Tick[] = [];
  if (!compact) {
    let lastX = -Infinity;
    let lastDay = "";
    const lastMainX = main.length ? main[main.length - 1]!.x : Infinity;
    for (const m of main) {
      const day = fmtDay(m.node.ts);
      if (m.recent || lastMainX - m.x < 40 || (divider && Math.abs(divider.x - m.x) < 34)) continue;
      if (day !== lastDay && m.x - lastX > 46) { ticks.push({ x: m.x, text: day }); lastX = m.x; }
      lastDay = day;
    }
  }

  const mainEnd = Math.max(o.width - (compact ? 8 : 16), ...branches.map((b) => b.end + 12), lastSlotX + 30);
  const width = mainEnd + (compact ? 8 : 16);
  return {
    width, height, mainY, mainStart: left - (compact ? 10 : 18), mainEnd, main, branches, lanes, ticks,
    ...(divider ? { divider } : {}), ...(historyLabelX !== undefined ? { historyLabelX } : {}),
  };
}
