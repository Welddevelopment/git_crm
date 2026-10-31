import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStore } from "./file";

const actor = { kind: "human", id: "joel" } as const;
const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mainline-fs-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("FileStore", () => {
  it("creates a missing dir and starts empty", () => {
    const dir = path.join(tmp(), "nested", "data");
    const s = new FileStore(dir);
    expect(fs.existsSync(dir)).toBe(true);
    expect(s.isEmpty()).toBe(true);
  });

  it("persists (debounced) and reloads", async () => {
    const dir = tmp();
    const s = new FileStore(dir, { debounceMs: 20 });
    await s.append("main", [{ actor, op: { type: "field.set", entity: "deal:a", field: "amount", value: 5 } }]);
    await s.createPR({
      title: "t",
      description: "",
      branch: "b",
      author: actor,
      status: "open",
      createdAt: 1,
      updatedAt: 1,
    });
    const file = path.join(dir, "mainline.json");
    expect(fs.existsSync(file)).toBe(false); // debounced
    await new Promise((r) => setTimeout(r, 80));
    expect(fs.existsSync(file)).toBe(true);

    const r = new FileStore(dir);
    expect(r.isEmpty()).toBe(false);
    expect((await r.events("main")).length).toBe(1);
    expect((await r.getPR("pr_1"))?.title).toBe("t");
    expect((await r.createPR({ ...(await r.getPR("pr_1"))!, id: undefined } as never)).id).toBe("pr_2");
  });

  it("flush writes immediately; corrupt file is tolerated", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "mainline.json"), "{not json");
    const s = new FileStore(dir);
    expect(s.isEmpty()).toBe(true);
    await s.putDocs([{ id: "d", kind: "note", ts: 1, title: "x", body: "y" }]);
    s.flush();
    const r = new FileStore(dir);
    expect((await r.listDocs()).map((d) => d.id)).toEqual(["d"]);
  });
});
