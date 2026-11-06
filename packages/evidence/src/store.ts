import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Observation } from "@cloud-agent/contracts";
import { redact } from "./redact.js";

export interface NewObservation {
  source: string;
  resource?: string;
  timeRange?: string;
  confidence?: Observation["confidence"];
  limitations?: string[];
}

export interface EvidenceStore {
  /** Persist a redacted payload and return the observation that points to it. */
  record(input: NewObservation, payload: unknown, now?: Date): Promise<Observation>;
  getPayload(evidenceRef: string): Promise<unknown>;
  list(): Promise<Observation[]>;
}

function build(input: NewObservation, id: string, now: Date): Observation {
  return {
    id,
    source: input.source,
    ...(input.resource !== undefined && { resource: input.resource }),
    ...(input.timeRange !== undefined && { timeRange: input.timeRange }),
    observedAt: now.toISOString(),
    evidenceRef: `artifact://observations/${id}`,
    confidence: input.confidence ?? "high",
    limitations: input.limitations ?? [],
  };
}

export class InMemoryEvidenceStore implements EvidenceStore {
  private readonly observations = new Map<string, { obs: Observation; payload: unknown }>();

  async record(input: NewObservation, payload: unknown, now = new Date()) {
    const obs = build(input, `obs-${randomUUID()}`, now);
    this.observations.set(obs.evidenceRef, { obs, payload: redact(payload) });
    return obs;
  }
  async getPayload(evidenceRef: string) {
    const hit = this.observations.get(evidenceRef);
    if (!hit) throw new Error(`unknown evidence ref ${evidenceRef}`);
    return hit.payload;
  }
  async list() {
    return [...this.observations.values()].map((v) => v.obs);
  }
}

/** Stores one redacted JSON file per observation under <dir>/<scope>/. Scope keeps tenants apart. */
export class FileEvidenceStore implements EvidenceStore {
  constructor(private readonly dir: string) {}

  async record(input: NewObservation, payload: unknown, now = new Date()) {
    const obs = build(input, `obs-${randomUUID()}`, now);
    await mkdir(this.dir, { recursive: true });
    await writeFile(
      join(this.dir, `${obs.id}.json`),
      JSON.stringify({ observation: obs, payload: redact(payload) }, null, 2),
      { mode: 0o600 },
    );
    return obs;
  }
  async getPayload(evidenceRef: string) {
    const id = evidenceRef.replace("artifact://observations/", "");
    if (!/^obs-[0-9a-f-]{36}$/.test(id)) throw new Error("invalid evidence ref");
    return JSON.parse(await readFile(join(this.dir, `${id}.json`), "utf8")).payload;
  }
  async list() {
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(this.dir).catch(() => [])).filter((f) => f.endsWith(".json"));
    const out: Observation[] = [];
    for (const f of files)
      out.push(JSON.parse(await readFile(join(this.dir, f), "utf8")).observation);
    return out;
  }
}
