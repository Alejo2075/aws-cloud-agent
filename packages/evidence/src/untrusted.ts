import { redactString } from "./redact.js";

const MAX_UNTRUSTED_CHARS = 8000;

/**
 * Wrap tool output / log lines / repository text before it enters model context.
 * The wrapper marks it as data; it is redacted and size-bounded. This reduces, but does not
 * eliminate, prompt-injection risk: authorization never depends on model output.
 */
export function wrapUntrusted(source: string, text: string): string {
  const safe = redactString(text).replaceAll("</untrusted", "<\\/untrusted");
  const clipped =
    safe.length > MAX_UNTRUSTED_CHARS ? `${safe.slice(0, MAX_UNTRUSTED_CHARS)}\n[truncated]` : safe;
  return `<untrusted source="${source.replace(/[^\w.:/-]/g, "_")}">\n${clipped}\n</untrusted>`;
}
