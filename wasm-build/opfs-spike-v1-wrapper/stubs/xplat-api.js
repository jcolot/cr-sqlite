// Minimal stub of @vlcn.io/xplat-api for the wrapper-validation harness.
// Only the runtime values the wrapper imports are needed; the TS type exports
// (DBAsync, StmtAsync, TXAsync, UpdateType, TMutex) are erased at build time.

// firstPick: first column of the first row, or undefined. (from xplat-api)
export function firstPick(rows) {
  const r = rows?.[0];
  if (r == null) return undefined;
  return Array.isArray(r) ? r[0] : Object.values(r)[0];
}

// cryb64: deterministic 64-bit-ish hash → bigint. Only used by automigrateTo (not
// exercised by this harness); a stable stand-in is sufficient.
export function cryb64(s, seed = 0n) {
  let h = BigInt.asUintN(64, 1469598103934665603n ^ seed);
  const prime = 1099511628211n;
  for (let i = 0; i < s.length; i++) {
    h = BigInt.asUintN(64, (h ^ BigInt(s.charCodeAt(i))) * prime);
  }
  return h;
}
