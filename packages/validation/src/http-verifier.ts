import { request } from "node:https";
import { lookup as dnsLookup } from "node:dns";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import type { ChangePlan, Verifier } from "@cloud-agent/changes";

type Criterion = ChangePlan["verification"][number];
type HttpCheck = Extract<NonNullable<Criterion["check"]>, { type: "http" }>;

/** False for loopback, private, link-local (incl. the metadata address), CGNAT, multicast and reserved ranges. */
export function isPublicAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) {
    const [a = 0, b = 0] = addr.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const x = addr.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped?.[1]) return isPublicAddress(mapped[1]);
    return !(
      x === "::" ||
      x === "::1" ||
      x.startsWith("fc") ||
      x.startsWith("fd") ||
      x.startsWith("fe8") ||
      x.startsWith("fe9") ||
      x.startsWith("fea") ||
      x.startsWith("feb") ||
      x.startsWith("ff")
    );
  }
  return false;
}

/** Resolves like the system resolver but refuses any answer that is not a public address, at connect time. */
export const guardedLookup: LookupFunction = (hostname, options, cb) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err, "", 4);
    const list = Array.isArray(addrs) ? addrs : [];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (bad || list.length === 0) {
      return cb(
        Object.assign(new Error(`refusing non-public address for ${hostname}`), {
          code: "EBLOCKED",
        }),
        "",
        4,
      );
    }
    const first = list[0]!;
    if (options.all) return (cb as unknown as (e: null, a: typeof list) => void)(null, list);
    return cb(null, first.address, first.family);
  });
};

export type HttpGet = (url: URL, timeoutMs: number) => Promise<{ status: number }>;

/** Default transport: HTTPS GET, no redirects, body discarded, DNS answers validated at connect time. */
export const httpsGet: HttpGet = (url, timeoutMs) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        lookup: guardedLookup,
        timeout: timeoutMs,
        headers: { "user-agent": "cloud-agent-verify" },
      },
      (res) => {
        res.destroy();
        resolve({ status: res.statusCode ?? 0 });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end();
  });

/** Why a URL may not be called, or undefined when it is allowed. */
export function urlProblem(raw: string, allowedHosts: string[]): string | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "invalid URL";
  }
  if (u.protocol !== "https:") return "only https URLs are allowed";
  if (u.username || u.password) return "credentials in URLs are not allowed";
  if (u.port && u.port !== "443") return "only the default https port is allowed";
  if (isIP(u.hostname.replace(/^\[|\]$/g, ""))) return "IP literals are not allowed";
  if (!allowedHosts.map((h) => h.toLowerCase()).includes(u.hostname.toLowerCase()))
    return `host ${u.hostname} is not in the connection's verification hosts`;
  return undefined;
}

/**
 * Evaluates `http` criteria. Outbound calls happen only to hosts the connection lists explicitly,
 * over HTTPS, to public addresses; anything else fails the criterion rather than being attempted.
 */
export function createHttpVerifier(deps: {
  allowedHosts: string[];
  rest: Verifier;
  get?: HttpGet;
}): Verifier {
  const get = deps.get ?? httpsGet;
  return {
    async verify(plan) {
      const delegated = await deps.rest.verify({
        ...plan,
        verification: plan.verification.filter((v) => v.check?.type !== "http"),
      });
      const out: Awaited<ReturnType<Verifier["verify"]>> = [];
      for (const v of plan.verification) {
        const c = v.check as HttpCheck | undefined;
        if (c?.type !== "http") {
          const d = delegated.find((x) => x.id === v.id);
          if (d) out.push(d);
          continue;
        }
        const problem = urlProblem(c.url, deps.allowedHosts);
        if (problem) {
          out.push({ id: v.id, passed: false, detail: `not attempted: ${problem}` });
          continue;
        }
        try {
          const { status } = await get(new URL(c.url), c.timeoutMs);
          out.push({
            id: v.id,
            passed: status === c.expectStatus,
            detail: `GET ${new URL(c.url).host}${new URL(c.url).pathname} returned ${status}; expected ${c.expectStatus}`,
          });
        } catch (e) {
          out.push({ id: v.id, passed: false, detail: `request failed: ${(e as Error).message}` });
        }
      }
      return out;
    },
  };
}
