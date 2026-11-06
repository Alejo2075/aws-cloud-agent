const SENSITIVE_KEY =
  /(secret|passw(or)?d|token|api[-_]?key|authorization|credential|private[-_]?key|session)/i;
const VALUE_PATTERNS: RegExp[] = [
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(aws_secret_access_key|secret_access_key)\s*[=:]\s*\S+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g,
];

export const REDACTED = "[REDACTED]";

export function redactString(value: string): string {
  return VALUE_PATTERNS.reduce((acc, re) => acc.replace(re, REDACTED), value);
}

/** Deep-redact a JSON-like value: sensitive keys lose their value, secret-shaped strings are masked. */
export function redact<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(walk);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) && v !== null && v !== undefined ? REDACTED : walk(v);
    }
    return out;
  }
  return value;
}
