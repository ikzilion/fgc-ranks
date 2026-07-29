// Shared formatting for the human-friendly sequential Event ID — same
// pattern as lib/playerId.ts's formatPlayerNumber, own Counter sequence
// ("eventNumber") so Event and Player numbering are independent.
export function formatEventNumber(n: number): string {
  return `EVT-${String(n).padStart(6, "0")}`;
}
