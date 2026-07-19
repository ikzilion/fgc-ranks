// Shared formatting for the human-friendly sequential Player ID. Kept in one
// place since both the GraphQL resolver and the one-off backfill script need
// the exact same format.
//
// 4 digits (FGC-0001 .. FGC-9999) gives room for 9999 players before a
// format change is needed — a reasonable starting point for this project's
// current scale.
export function formatPlayerNumber(n: number): string {
  return `FGC-${String(n).padStart(4, "0")}`;
}
