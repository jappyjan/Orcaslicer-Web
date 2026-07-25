/**
 * Display formatting for the results panel.
 *
 * The spec asks the results panel for time, grams, metres and layer count — and nothing
 * else. In particular `first_layer_time` is *not* here and must not be added: SPEC
 * verified deviation #6 measured it as uninitialised garbage
 * (`16745348785772691456.000000`), and the API deliberately does not expose it.
 */

/** `873` → `14 min 33 s`, `9412` → `2 h 37 min`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min ${rest} s`;
  return `${rest} s`;
}

export function formatGrams(grams: number): string {
  if (!Number.isFinite(grams)) return '—';
  if (grams >= 100) return `${Math.round(grams)} g`;
  return `${grams.toFixed(grams < 10 ? 2 : 1)} g`;
}

export function formatMetres(metres: number): string {
  if (!Number.isFinite(metres)) return '—';
  if (metres >= 100) return `${Math.round(metres)} m`;
  return `${metres.toFixed(metres < 10 ? 2 : 1)} m`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatElapsed(ms: number): string {
  return formatDuration(Math.max(0, Math.floor(ms / 1000)));
}
