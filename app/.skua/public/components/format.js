// Display formatters. Pure functions; no DOM access.

// Format a byte count as a human-readable string with one decimal place
// at KB/MB scale. `formatBytes(0)` → "0 B", `formatBytes(1536)` → "1.5 KB",
// `formatBytes(2_500_000)` → "2.4 MB".
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
