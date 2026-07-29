// Shared formatting for the human-friendly sequential Player ID. Kept in one
// place since both the GraphQL resolver and the one-off backfill script need
// the exact same format.
//
// 6 digits (FGC-000001 .. FGC-999999) gives room for 999,999 players before
// a format change is needed.
export function formatPlayerNumber(n: number): string {
  return `FGC-${String(n).padStart(6, "0")}`;
}
