import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAuditLog, InMemoryAuditLog, verifyChain } from "./index.js";

const input = { actor: "u", action: "ask", systemId: "s", outcome: "ok" as const };

describe("audit log", () => {
  it("chains records and redacts details", async () => {
    const log = new InMemoryAuditLog();
    await log.append({ ...input, detail: { token: "abc", q: "hi" } });
    await log.append(input);
    const rs = await log.read();
    expect(rs[0]!.detail).toEqual({ token: "[REDACTED]", q: "hi" });
    expect(verifyChain(rs)).toEqual({ ok: true });
  });
  it("detects tampering in a file log, including concurrent appends", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "a-")), "audit.jsonl");
    const log = new FileAuditLog(file);
    await Promise.all([log.append(input), log.append(input), log.append(input)]);
    expect(verifyChain(await log.read())).toEqual({ ok: true });
    const lines = (await readFile(file, "utf8")).split("\n");
    await writeFile(file, lines.join("\n").replace('"outcome":"ok"', '"outcome":"denied"'));
    expect(verifyChain(await log.read()).ok).toBe(false);
  });
});
