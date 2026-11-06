import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SystemGraph } from "@cloud-agent/contracts";

/** Storage seam so DynamoDB/S3 or a graph database can replace the file store later. */
export interface GraphStore {
  save(graph: SystemGraph): Promise<void>;
  load(key: GraphKey): Promise<SystemGraph | undefined>;
}

export interface GraphKey {
  accountId: string;
  region: string;
  systemId: string;
  environment: string;
}

const safe = (s: string) => s.replace(/[^\w.-]/g, "_");

export const graphKeyPath = (k: GraphKey) =>
  join(safe(k.accountId), safe(k.region), safe(k.systemId), `${safe(k.environment)}.json`);

export class InMemoryGraphStore implements GraphStore {
  private readonly graphs = new Map<string, SystemGraph>();
  async save(graph: SystemGraph) {
    this.graphs.set(graphKeyPath(graph), graph);
  }
  async load(key: GraphKey) {
    return this.graphs.get(graphKeyPath(key));
  }
}

/** Tenant/account isolation is part of the path: <root>/<account>/<region>/<system>/<env>.json */
export class FileGraphStore implements GraphStore {
  constructor(private readonly root: string) {}
  async save(graph: SystemGraph) {
    const file = join(this.root, graphKeyPath(graph));
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify(SystemGraph.parse(graph), null, 2), { mode: 0o600 });
  }
  async load(key: GraphKey) {
    try {
      return SystemGraph.parse(
        JSON.parse(await readFile(join(this.root, graphKeyPath(key)), "utf8")),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }
}
