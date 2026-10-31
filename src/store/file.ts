/** FileStore (W5): MemoryStore + debounced JSON snapshot at `${dir}/mainline.json`. */
import fs from "node:fs";
import path from "node:path";
import { MemoryStore } from "./memory";

export class FileStore extends MemoryStore {
  readonly dir: string;
  readonly file: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loading = false;
  private readonly debounceMs: number;

  constructor(dir: string, opts?: { debounceMs?: number }) {
    super();
    this.dir = dir;
    this.file = path.join(dir, "mainline.json");
    this.debounceMs = opts?.debounceMs ?? 250;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.warn(`[mainline] FileStore: cannot create ${dir}:`, err);
    }
    if (fs.existsSync(this.file)) {
      try {
        const raw = fs.readFileSync(this.file, "utf8");
        this.loading = true;
        this.loadSnapshot(JSON.parse(raw));
      } catch (err) {
        console.warn(`[mainline] FileStore: ignoring unreadable snapshot ${this.file}:`, err);
      } finally {
        this.loading = false;
      }
    }
  }

  /** True when the store holds nothing (use to decide seed-on-boot). */
  isEmpty(): boolean {
    return this.logs.size === 0 && this.branches.size === 0 && this.prs.size === 0 && this.docs.size === 0;
  }

  protected override onMutation(): void {
    if (this.loading) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
    // don't keep the process alive just for a pending snapshot
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Write the snapshot now (atomic via tmp + rename). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.toJSON()));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`[mainline] FileStore: snapshot write failed:`, err);
    }
  }
}
