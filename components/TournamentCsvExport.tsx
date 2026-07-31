// components/TournamentCsvExport.tsx
// CSV export for an ENDED tournament's results (user request, July 30,
// 2026) -- two separate downloads: Final Standings (one row per entrant)
// and Full Match Log (one row per COMPLETED match). Generated entirely
// client-side from data the tournament page already fetched (no new API
// route, no new library -- a Blob + <a download> is all browsers need).
//
// Scope decision: Pool + Bracket tournaments' pool-stage matches ARE
// included (real historical results, not just the top-cut main bracket) --
// both in the win/loss tally and the match log. Since every pool's own
// bracket independently produces round labels like "Winners Round 1" /
// "Grand Finals" (lib/bracket.ts has no pool-aware naming), a pool-stage
// row's Round column gets a "Pool N - " prefix to disambiguate; the main/
// standard bracket's rows are left unprefixed since there's only ever one
// of those per tournament.
//
// Player ID (Player.displayId) is deliberately NOT included in Final
// Standings, even though it was in the first cut of this feature (removed
// July 30, 2026) -- displayId is gated everywhere else on the site to the
// profile owner, Admin, or TO (see that resolver), and a downloaded CSV can
// end up shared or posted far more broadly than the page it came from, so
// it shouldn't leak the ID at all regardless of who downloaded it or what
// their permissions were at the time.
"use client";

interface ExportEntrant {
  id: string;
  placement: number | null;
  pointsEarned: number;
  player: { id: string; tag: string };
}

interface ExportMatch {
  round: string;
  status: string;
  bracketSide: string | null;
  player1Score: number;
  player2Score: number;
  player1: { id: string; tag: string } | null;
  player2: { id: string; tag: string } | null;
  winner: { id: string; tag: string } | null;
}

interface MatchGroup {
  label: string; // "" for the main/standard bracket, "Pool N" for a pool's matches
  matches: ExportMatch[];
}

const BRACKET_SIDE_LABELS: Record<string, string> = {
  WINNERS: "Winners",
  LOSERS: "Losers",
  GRAND_FINAL: "Final",
  GRAND_FINAL_RESET: "Final",
};

// Dependency-free CSV cell escaping — quote the field and double up any
// embedded quotes whenever a comma, quote, or newline could otherwise
// corrupt the row (a player tag is free-text and can contain any of these).
function csvCell(value: string | number): string {
  const str = String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function downloadCsv(filename: string, rows: (string | number)[][]) {
  const csv = rows.map(row => row.map(csvCell).join(",")).join("\r\n");
  // Leading BOM so Excel (which guesses encoding without one) renders
  // non-ASCII player tags correctly instead of mangling them.
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function TournamentCsvExport({
  tournamentName,
  entrants,
  matchGroups,
}: {
  tournamentName: string;
  entrants: ExportEntrant[];
  matchGroups: MatchGroup[];
}) {
  function exportStandings() {
    const winLoss = new Map<string, { wins: number; losses: number }>();
    for (const group of matchGroups) {
      for (const m of group.matches) {
        if (m.status !== "COMPLETED" || !m.winner) continue;
        for (const p of [m.player1, m.player2]) {
          if (!p) continue;
          const rec = winLoss.get(p.id) ?? { wins: 0, losses: 0 };
          if (m.winner.id === p.id) rec.wins++;
          else rec.losses++;
          winLoss.set(p.id, rec);
        }
      }
    }

    const rows: (string | number)[][] = [["Placement", "Player Tag", "Wins", "Losses", "Points Earned"]];
    const sorted = [...entrants].sort((a, b) => (a.placement ?? Infinity) - (b.placement ?? Infinity));
    for (const e of sorted) {
      const rec = winLoss.get(e.player.id) ?? { wins: 0, losses: 0 };
      rows.push([e.placement ?? "", e.player.tag, rec.wins, rec.losses, e.pointsEarned]);
    }
    downloadCsv(`${tournamentName} - Final Standings.csv`, rows);
  }

  function exportMatchLog() {
    const rows: (string | number)[][] = [
      ["Round", "Bracket Side", "Player 1", "Player 1 Score", "Player 2", "Player 2 Score", "Winner"],
    ];
    for (const group of matchGroups) {
      const prefix = group.label ? `${group.label} - ` : "";
      for (const m of group.matches) {
        if (m.status !== "COMPLETED") continue;
        rows.push([
          `${prefix}${m.round}`,
          m.bracketSide ? BRACKET_SIDE_LABELS[m.bracketSide] ?? m.bracketSide : "",
          m.player1?.tag ?? "",
          m.player1Score,
          m.player2?.tag ?? "",
          m.player2Score,
          m.winner?.tag ?? "",
        ]);
      }
    }
    downloadCsv(`${tournamentName} - Match Log.csv`, rows);
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        onClick={exportStandings}
        className="text-[11px] font-semibold px-3 py-1.5 rounded"
        style={{ background: "var(--blue-dim)", color: "var(--blue)", border: "1px solid rgba(79,142,247,0.25)" }}
      >
        ⬇ Standings CSV
      </button>
      <button
        onClick={exportMatchLog}
        className="text-[11px] font-semibold px-3 py-1.5 rounded"
        style={{ background: "var(--blue-dim)", color: "var(--blue)", border: "1px solid rgba(79,142,247,0.25)" }}
      >
        ⬇ Match Log CSV
      </button>
    </div>
  );
}
