import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { redact } from "./redact.js";

export interface AuditInput {
  actor: string;
  action: string;
  systemId: string;
  environment?: string;
  target?: string;
  planHash?: string;
  approvalId?: string;
  outcome: "ok" | "denied" | "error";
  detail?: unknown;
}

export interface AuditRecord extends AuditInput {
  id: string;
  at: string;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

export function hashRecord(r: Omit<AuditRecord, "hash">): string {
  return createHash("sha256").update(JSON.stringify(r)).digest("hex");
}

export interface AuditLog {
  append(input: AuditInput, now?: Date): Promise<AuditRecord>;
  read(): Promise<AuditRecord[]>;
}

/** Tamper-evident: every record embeds the hash of the previous one. */
export function verifyChain(records: AuditRecord[]): { ok: boolean; brokenAt?: number } {
  let prev = GENESIS;
  for (const [i, r] of records.entries()) {
    const { hash, ...rest } = r;
    if (r.prevHash !== prev || hashRecord(rest) !== hash) return { ok: false, brokenAt: i };
    prev = hash;
  }
  return { ok: true };
}

function seal(input: AuditInput, prevHash: string, now: Date): AuditRecord {
  const base = {
    ...input,
    detail: input.detail === undefined ? undefined : redact(input.detail),
    id: randomUUID(),
    at: now.toISOString(),
    prevHash,
  };
  if (base.detail === undefined) delete (base as { detail?: unknown }).detail;
  return { ...base, hash: hashRecord(base) };
}

export class InMemoryAuditLog implements AuditLog {
  private records: AuditRecord[] = [];
  async append(input: AuditInput, now = new Date()) {
    const r = seal(input, this.records.at(-1)?.hash ?? GENESIS, now);
    this.records.push(r);
    return r;
  }
  async read() {
    return [...this.records];
  }
}

export class FileAuditLog implements AuditLog {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}
  async read(): Promise<AuditRecord[]> {
    try {
      return (await readFile(this.file, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as AuditRecord);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }
  /** Serialized within the process so the chain cannot fork. */
  append(input: AuditInput, now = new Date()): Promise<AuditRecord> {
    const run = this.tail.then(async () => {
      const prev = (await this.read()).at(-1)?.hash ?? GENESIS;
      const r = seal(input, prev, now);
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, `${JSON.stringify(r)}\n`, { mode: 0o600 });
      return r;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}
