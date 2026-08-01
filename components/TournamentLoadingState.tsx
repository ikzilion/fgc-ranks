// components/TournamentLoadingState.tsx
// Suspense fallback for the tournament page's bracket/pools/entrants section
// -- shown for however long the full detail query actually takes (which can
// still be several seconds on a large Pools + Bracket tournament even after
// the N+1 fixes), with real numbers instead of a generic spinner so it
// doesn't read as the site having crashed. Presentational only -- no fetch
// of its own, just props from the fast summary query already rendered
// above it (85-pool tournament loading-state work, Aug 1, 2026).

export function TournamentLoadingState({
  entrantCount,
  poolCount,
  isPoolsFormat,
}: {
  entrantCount: number;
  poolCount: number;
  isPoolsFormat: boolean;
}) {
  const entrantWord = entrantCount === 1 ? "entrant" : "entrants";
  const mainLine =
    isPoolsFormat && poolCount > 0
      ? `Loading ${poolCount} pool${poolCount === 1 ? "" : "s"}, ${entrantCount} ${entrantWord}…`
      : `Loading ${entrantCount} ${entrantWord}…`;
  const subLine = isPoolsFormat ? "Building the pools and bracket" : "Building the bracket";

  return (
    <div className="max-w-5xl mx-auto mb-6">
      <div className="fgc-card p-10 flex flex-col items-center justify-center gap-3 text-center">
        <div
          className="w-8 h-8 rounded-full animate-spin"
          style={{ border: "3px solid var(--border-strong)", borderTopColor: "var(--blue)" }}
        />
        <p className="font-rajdhani text-lg font-semibold text-[var(--text-primary)]">{mainLine}</p>
        <p className="text-[13px] text-[var(--text-secondary)]">{subLine}</p>
      </div>
    </div>
  );
}
