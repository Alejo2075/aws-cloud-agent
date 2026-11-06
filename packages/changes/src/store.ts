import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChangeRecord } from "./state.js";

export interface ChangeStore {
  get(changeId: string): Promise<ChangeRecord | undefined>;
  put(rec: ChangeRecord): Promise<void>;
  list(): Promise<ChangeRecord[]>;
  /** Execution records keyed by idempotency key survive restarts and block duplicate applies. */
  findExecution(key: string): Promise<ChangeRecord | undefined>;
}

export class InMemoryChangeStore implements ChangeStore {
  private readonly m = new Map<string, ChangeRecord>();
  async get(id: string) {
    return this.m.get(id);
  }
  async put(rec: ChangeRecord) {
    this.m.set(rec.plan.changeId, structuredClone(rec));
  }
  async list() {
    return [...this.m.values()];
  }
  async findExecution(key: string) {
    return [...this.m.values()].find((r) => r.execution?.idempotencyKey === key);
  }
}

export class FileChangeStore implements ChangeStore {
  constructor(private readonly dir: string) {}
  private path(id: string) {
    if (!/^[\w.-]+$/.test(id)) throw new Error("invalid change id");
    return join(this.dir, `${id}.json`);
  }
  async get(id: string) {
    try {
      return JSON.parse(await readFile(this.path(id), "utf8")) as ChangeRecord;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }
  async put(rec: ChangeRecord) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path(rec.plan.changeId), JSON.stringify(rec, null, 2), { mode: 0o600 });
  }
  async list() {
    const { readdir } = await import("node:fs/promises");
    const names = (await readdir(this.dir).catch(() => [])).filter((n) => n.endsWith(".json"));
    return Promise.all(
      names.map(async (n) => JSON.parse(await readFile(join(this.dir, n), "utf8")) as ChangeRecord),
    );
  }
  async findExecution(key: string) {
    return (await this.list()).find((r) => r.execution?.idempotencyKey === key);
  }
}
