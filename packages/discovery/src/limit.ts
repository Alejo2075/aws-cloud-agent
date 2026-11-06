/** Minimal concurrency limiter so discovery cannot flood AWS APIs. */
export function createLimiter(concurrency: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  const next = () => {
    active--;
    waiting.shift()?.();
  };
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= concurrency) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}
