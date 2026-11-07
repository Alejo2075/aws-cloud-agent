// Runs inside the isolated plugin process (node --permission, no network/child/worker/write).
// Protocol: one JSON object per line on stdin/stdout. Plain JavaScript on purpose: it must run without a build step.
import { createInterface } from "node:readline";

const pluginPath = process.argv[2];
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const has = (scope) => {
  try {
    return process.permission ? process.permission.has(scope) : true;
  } catch {
    return true;
  }
};

let tools;
try {
  const mod = await import(new URL(`file://${pluginPath}`).href);
  tools = typeof mod.tools === "function" ? await mod.tools() : mod.tools;
  if (!Array.isArray(tools)) throw new Error("plugin must export `tools` (array)");
} catch (e) {
  send({ type: "error", message: String(e && e.message ? e.message : e) });
  process.exit(1);
}

send({
  type: "ready",
  capabilities: {
    net: has("net"),
    child: has("child"),
    worker: has("worker"),
    fsWrite: has("fs.write"),
    addon: has("addon"),
  },
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
});

const byName = new Map(tools.map((t) => [t.name, t]));
for await (const line of createInterface({ input: process.stdin })) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    continue;
  }
  if (msg.type !== "call") continue;
  try {
    const t = byName.get(msg.tool);
    if (!t) throw new Error(`unknown tool ${msg.tool}`);
    send({ type: "result", id: msg.id, data: await t.run(msg.input) });
  } catch (e) {
    send({ type: "failure", id: msg.id, message: String(e && e.message ? e.message : e) });
  }
}
