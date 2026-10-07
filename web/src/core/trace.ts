// The crypto pipeline as it happens, for the console's "verbose on". Nothing here is stored or
// sent: lines go to whoever is listening in this tab, and nobody listens unless verbose is on.

type Sink = (line: string) => void;
const sinks = new Set<Sink>();

export function trace(line: string | (() => string)) {
  if (sinks.size === 0) return;
  const s = typeof line === 'function' ? line() : line;
  sinks.forEach((f) => f(s));
}

export function onTrace(f: Sink): () => void {
  sinks.add(f);
  return () => {
    sinks.delete(f);
  };
}

export const short = (hex: string, n = 8) => (hex.length > n * 2 ? `${hex.slice(0, n)}…${hex.slice(-4)}` : hex);
