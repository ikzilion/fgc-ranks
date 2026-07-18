// components/BracketView.tsx
"use client";

import { ReportMatchButton } from "./ReportMatchButton";

interface BracketMatch {
  id: string;
  round: string;
  status: string;
  bracketSide: string;
  bracketRound: number;
  bracketPosition: number;
  player1Score: number;
  player2Score: number;
  player1?: { id: string; tag: string } | null;
  player2?: { id: string; tag: string } | null;
  winner?: { id: string; tag: string } | null;
}

const SEEDING_LABELS: Record<string, string> = {
  RANDOM: "Fully random",
  RANDOM_WITHIN_TIERS: "Random within tiers",
  MANUAL: "Manual",
};

const SIDE_LABELS: Record<string, string> = {
  WINNERS: "Winners Bracket",
  LOSERS: "Losers Bracket",
  GRAND_FINAL: "Grand Finals",
  GRAND_FINAL_RESET: "Bracket Reset",
};

function PlayerRow({ player, score, status, isWinner }: { player?: { id: string; tag: string } | null; score: number; status: string; isWinner: boolean }) {
  return (
    <div className={`flex items-center justify-between py-1 ${isWinner ? "opacity-100" : "opacity-60"}`}>
      <span
        className="font-rajdhani text-[13px] font-semibold truncate"
        style={{ color: player ? "var(--text-primary)" : "var(--text-muted)", fontStyle: player ? "normal" : "italic" }}
      >
        {player ? player.tag : "TBD"}
      </span>
      <span className="font-rajdhani text-[13px] font-bold" style={{ color: isWinner ? "var(--green)" : "var(--text-muted)" }}>
        {status === "COMPLETED" ? score : "—"}
      </span>
    </div>
  );
}

function MatchCard({ match, canManage }: { match: BracketMatch; canManage: boolean }) {
  const ready = !!match.player1 && !!match.player2;

  return (
    <div className="fgc-card p-3 w-56 flex-shrink-0">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">{match.round}</p>
        {ready && <ReportMatchButton match={match as any} canManage={canManage} />}
      </div>

      <PlayerRow player={match.player1} score={match.player1Score} status={match.status} isWinner={!!match.winner && match.winner.id === match.player1?.id} />
      <PlayerRow player={match.player2} score={match.player2Score} status={match.status} isWinner={!!match.winner && match.winner.id === match.player2?.id} />
    </div>
  );
}

function BracketSideSection({ side, matches, canManage }: { side: string; matches: BracketMatch[]; canManage: boolean }) {
  const rounds = new Map<number, BracketMatch[]>();
  for (const m of matches) {
    if (!rounds.has(m.bracketRound)) rounds.set(m.bracketRound, []);
    rounds.get(m.bracketRound)!.push(m);
  }
  const roundNumbers = [...rounds.keys()].sort((a, b) => a - b);

  return (
    <div className="mb-6">
      <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-3">{SIDE_LABELS[side] ?? side}</p>
      <div className="flex gap-4 overflow-x-auto pb-2">
        {roundNumbers.map(r => (
          <div key={r} className="flex flex-col gap-3 justify-center">
            {rounds.get(r)!
              .sort((a, b) => a.bracketPosition - b.bracketPosition)
              .map(m => (
                <MatchCard key={m.id} match={m} canManage={canManage} />
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function BracketView({
  bracket,
  canManage,
}: {
  bracket: { seedingMethod: string; size: number; matches: BracketMatch[] };
  canManage: boolean;
}) {
  const bySide: Record<string, BracketMatch[]> = { WINNERS: [], LOSERS: [], GRAND_FINAL: [], GRAND_FINAL_RESET: [] };
  for (const m of bracket.matches) {
    if (bySide[m.bracketSide]) bySide[m.bracketSide].push(m);
  }

  return (
    <div>
      <p className="text-[12px] mb-4" style={{ color: "var(--text-secondary)" }}>
        Seeded: {SEEDING_LABELS[bracket.seedingMethod] ?? bracket.seedingMethod} · Bracket size {bracket.size}
      </p>

      {bySide.WINNERS.length > 0 && <BracketSideSection side="WINNERS" matches={bySide.WINNERS} canManage={canManage} />}
      {bySide.LOSERS.length > 0 && <BracketSideSection side="LOSERS" matches={bySide.LOSERS} canManage={canManage} />}
      {bySide.GRAND_FINAL.length > 0 && <BracketSideSection side="GRAND_FINAL" matches={bySide.GRAND_FINAL} canManage={canManage} />}
      {bySide.GRAND_FINAL_RESET.length > 0 && <BracketSideSection side="GRAND_FINAL_RESET" matches={bySide.GRAND_FINAL_RESET} canManage={canManage} />}
    </div>
  );
}
