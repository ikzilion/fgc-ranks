// lib/roundRobin.ts
// Pool format Model A: round-robin pool generation + standings. Every
// entrant in a pool plays every other entrant in that pool exactly once —
// no elimination bracket within the pool, unlike Models B/C. Kept separate
// from lib/bracket.ts's buildDoubleEliminationBracket, which those models
// use; a round-robin pool's matches are wired via Match.poolId instead of
// bracketId, since there's no bracket structure for them to advance through.

import { Types } from "mongoose";
import { Match } from "@/models/Match";
import { shuffle } from "@/lib/bracket";

export interface RoundRobinMatchDraft {
  _id: Types.ObjectId;
  tournamentId: any;
  poolId: Types.ObjectId;
  player1Id: Types.ObjectId;
  player2Id: Types.ObjectId;
  round: string;
  status: "PENDING";
}

// Every unordered pair of entrants plays exactly once — the definition of
// round-robin. Which player lands in player1/player2 is arbitrary; unlike a
// bracket match, there's no seeding meaning attached to that order.
export function buildRoundRobinMatches(params: {
  tournamentId: any;
  poolId: Types.ObjectId;
  playerIds: string[];
}): { matches: RoundRobinMatchDraft[] } {
  const { tournamentId, poolId, playerIds } = params;
  const matches: RoundRobinMatchDraft[] = [];

  for (let i = 0; i < playerIds.length; i++) {
    for (let j = i + 1; j < playerIds.length; j++) {
      matches.push({
        _id: new Types.ObjectId(),
        tournamentId,
        poolId,
        player1Id: new Types.ObjectId(playerIds[i]),
        player2Id: new Types.ObjectId(playerIds[j]),
        round: "Pool Play",
        status: "PENDING",
      });
    }
  }

  return { matches };
}

export interface RoundRobinStandingRow {
  playerId: string;
  matchWins: number;
  matchLosses: number;
  gamesWon: number;
  gamesLost: number;
  rank: number; // 1-indexed
}

// Standings + tiebreakers, matching start.gg's own documented default order:
//   (1) sets won (match win count) — primary ranking
//   (2) total games won across all pool matches — first tiebreaker
//   (3) head-to-head result between the specific tied players — second tiebreaker
//   (4) still tied after all three — random
//
// (3) is resolved as a mini round-robin among just the tied group: each
// tied player's win count against ONLY the other members of that same tied
// group. For a 2-player tie that's a plain head-to-head result; for a
// larger tied group it's what "head-to-head between the specific tied
// players" actually means once there are 3+ of them. If that mini
// round-robin is itself a perfect cycle (A beat B, B beat C, C beat A — each
// with one sub-win and one sub-loss), there's no ordering left to derive
// and (4) applies: a random shuffle of whoever's left tied.
export async function computeRoundRobinStandings(poolId: any, playerIds: string[]): Promise<RoundRobinStandingRow[]> {
  const matches = await Match.find({ poolId, status: "COMPLETED" });

  const stats = new Map<string, { matchWins: number; matchLosses: number; gamesWon: number; gamesLost: number }>();
  for (const pid of playerIds) stats.set(pid, { matchWins: 0, matchLosses: 0, gamesWon: 0, gamesLost: 0 });

  for (const m of matches) {
    if (!m.winnerId || !m.player1Id || !m.player2Id) continue;
    const p1 = m.player1Id.toString();
    const p2 = m.player2Id.toString();
    const winnerId = m.winnerId.toString();
    const loserId = winnerId === p1 ? p2 : p1;
    if (!stats.has(winnerId) || !stats.has(loserId)) continue; // defensive — shouldn't happen

    stats.get(winnerId)!.matchWins++;
    stats.get(loserId)!.matchLosses++;
    // A forfeit has no real games played — player1Score/player2Score stay at
    // their 0 defaults, so this naturally contributes 0 games either way.
    stats.get(p1)!.gamesWon += m.player1Score;
    stats.get(p1)!.gamesLost += m.player2Score;
    stats.get(p2)!.gamesWon += m.player2Score;
    stats.get(p2)!.gamesLost += m.player1Score;
  }

  // Group players by (matchWins, gamesWon) — anyone sharing both values
  // enters the head-to-head tiebreaker together.
  const sorted = [...playerIds].sort((a, b) => {
    const sa = stats.get(a)!, sb = stats.get(b)!;
    if (sa.matchWins !== sb.matchWins) return sb.matchWins - sa.matchWins;
    return sb.gamesWon - sa.gamesWon;
  });

  const ranked: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (
      j < sorted.length &&
      stats.get(sorted[j])!.matchWins === stats.get(sorted[i])!.matchWins &&
      stats.get(sorted[j])!.gamesWon === stats.get(sorted[i])!.gamesWon
    ) {
      j++;
    }
    const group = sorted.slice(i, j);
    ranked.push(...(group.length > 1 ? breakTiesByHeadToHead(group, matches) : group));
    i = j;
  }

  return ranked.map((pid, idx) => ({ playerId: pid, ...stats.get(pid)!, rank: idx + 1 }));
}

function breakTiesByHeadToHead(group: string[], matches: any[]): string[] {
  const groupSet = new Set(group);
  const subWins = new Map(group.map(pid => [pid, 0]));

  for (const m of matches) {
    if (!m.winnerId || !m.player1Id || !m.player2Id) continue;
    const p1 = m.player1Id.toString();
    const p2 = m.player2Id.toString();
    if (!groupSet.has(p1) || !groupSet.has(p2)) continue; // only counts within this tied group
    const winnerId = m.winnerId.toString();
    subWins.set(winnerId, (subWins.get(winnerId) ?? 0) + 1);
  }

  const bySubWins = [...group].sort((a, b) => (subWins.get(b) ?? 0) - (subWins.get(a) ?? 0));

  const result: string[] = [];
  let i = 0;
  while (i < bySubWins.length) {
    let j = i + 1;
    while (j < bySubWins.length && subWins.get(bySubWins[j]) === subWins.get(bySubWins[i])) j++;
    const stillTied = bySubWins.slice(i, j);
    result.push(...(stillTied.length > 1 ? shuffle(stillTied) : stillTied));
    i = j;
  }
  return result;
}
