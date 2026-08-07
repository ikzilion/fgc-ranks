// graphql/loaders.ts
//
// Per-request batching for the GraphQL fan-out fields that were doing one
// individual findById per item with zero batching (Match.player1/player2/
// winner/nextMatch/nextLoserMatch, Entrant.player) -- a single tournament
// page load was measured at 791 separate DB round trips (549 Player + 227
// Match) driven almost entirely by this. See the Notion "FGC Ranks — Claude
// Context" page's Phase 7 follow-up for the full before/after numbers.
//
// createLoaders() must be called ONCE PER REQUEST (wired into the Apollo
// context factory in app/api/graphql/route.ts) -- a DataLoader instance
// caches every id it's ever loaded for its own lifetime, so sharing one
// across requests would leak stale data between unrelated GraphQL calls.
import DataLoader from "dataloader";
import { Types } from "mongoose";
import { Player } from "@/models/Player";
import { Match } from "@/models/Match";
import { Event } from "@/models/Event";
import { Tournament } from "@/models/Tournament";
import { Bracket } from "@/models/Bracket";
import { Entrant } from "@/models/Entrant";
import { Pool } from "@/models/Pool";
import { getLiveStatuses } from "@/lib/twitch";
import { nonStaleTournamentMatch } from "@/lib/tournamentVisibility";

// DataLoader requires each batch to return results in the SAME ORDER as the
// keys it was given (not just the same set) -- both loaders below fetch with
// a single $in query, then re-map by id to restore that order, filling any
// id with no matching document with null (a dangling reference, e.g. a
// deleted Player, shouldn't ever throw here -- the field resolver's existing
// null-handling for a missing document is unchanged from before this fix).
function batchById<T extends { _id: unknown }>(Model: { find: (filter: Record<string, unknown>) => Promise<T[]> }) {
  return async (ids: readonly string[]): Promise<(T | null)[]> => {
    const docs = await Model.find({ _id: { $in: ids as string[] } });
    const byId = new Map(docs.map(doc => [(doc._id as { toString(): string }).toString(), doc]));
    return ids.map(id => byId.get(id) ?? null);
  };
}

// Batches Game.tournamentCount (one countDocuments per game before this --
// the /games list page requests it for every row) into a single grouped
// aggregation. Any game name with no matching tournament gets 0, same
// zero-default re-mapping approach as the count/gameCount loader below.
// Applies the same nonStaleTournamentMatch filter as Query.tournaments --
// without it, a stale zero-entrant UPCOMING tournament (hidden from the
// public listing but never deleted) still inflated this count, so a game
// could show "1 tournament" on the Games tab with zero actually browsable
// (COTW bug, Aug 2026).
function batchGameTournamentCounts() {
  return async (names: readonly string[]): Promise<number[]> => {
    const rows = await Tournament.aggregate([
      { $match: { game: { $in: names as string[] }, ...nonStaleTournamentMatch() } },
      { $group: { _id: "$game", count: { $sum: 1 } } },
    ]);
    const countByName = new Map(rows.map((r: { _id: string; count: number }) => [r._id, r.count]));
    return names.map(name => countByName.get(name) ?? 0);
  };
}

// Batches Event.tournamentCount + Event.gameCount, previously TWO separate
// per-event queries (countDocuments + distinct) each -- the /events list
// page requests both fields for every row. One grouped aggregation gives
// both the count and the distinct-game count ($addToSet + array length) for
// every event in a single query; both field resolvers share this one
// loader, since DataLoader already coalesces multiple .load() calls for the
// same key within a request into one batch.
// Applies nonStaleTournamentMatch for the same reason batchGameTournamentCounts
// does above -- otherwise a stale zero-entrant UPCOMING tournament linked to
// an event would inflate its count past what's actually browsable.
function batchEventTournamentStats() {
  return async (eventIds: readonly string[]): Promise<{ tournamentCount: number; gameCount: number }[]> => {
    // Tournament.eventId is stored as an ObjectId, but unlike Model.find(),
    // Model.aggregate() sends the pipeline straight to the driver with no
    // schema-aware casting -- a raw string here silently matches nothing
    // (confirmed empirically: countDocuments found a real linked tournament,
    // the same $match with a string eventId returned zero rows). Cast
    // explicitly, same requirement as Mongo's ObjectId comparison rules.
    const objectIds = eventIds.map(id => new Types.ObjectId(id));
    const rows = await Tournament.aggregate([
      { $match: { eventId: { $in: objectIds }, ...nonStaleTournamentMatch() } },
      { $group: { _id: "$eventId", count: { $sum: 1 }, games: { $addToSet: "$game" } } },
    ]);
    const statsById = new Map(
      rows.map((r: { _id: unknown; count: number; games: string[] }) => [
        (r._id as { toString(): string }).toString(),
        { tournamentCount: r.count, gameCount: r.games.length },
      ])
    );
    return eventIds.map(id => statsById.get(id) ?? { tournamentCount: 0, gameCount: 0 });
  };
}

// Batches Pool.bracket (one Bracket.findOne({ poolId }) per pool before this
// -- 85 individual round trips on an 85-pool tournament) into a single
// find({poolId:{$in:...}}). True 1:1 like batchById -- Bracket.poolId has
// its own partial unique index (models/Bracket.ts), so a pool has at most
// one bracket.
function batchBracketByPoolId() {
  return async (poolIds: readonly string[]): Promise<(InstanceType<typeof Bracket> | null)[]> => {
    const brackets = await Bracket.find({ poolId: { $in: poolIds as string[] } });
    const byPoolId = new Map(brackets.map(b => [(b.poolId as { toString(): string }).toString(), b]));
    return poolIds.map(id => byPoolId.get(id) ?? null);
  };
}

// Batches Bracket.matches (one Match.find({ bracketId }) per bracket before
// this -- another 85 individual round trips, one per pool's own bracket) into
// a single find({bracketId:{$in:...}}). Unlike the 1:1 loaders above, a
// bracket has MANY matches, so this groups the single sorted result set back
// out per bracketId instead of remapping one document per key -- the overall
// query is sorted once by {bracketRound:1, bracketPosition:1}, and pushing
// into each bracketId's array in that same order preserves the per-bracket
// sort without re-sorting each group individually.
//
// This is the loader that actually mattered for the 85-pool tournament perf
// investigation (Aug 1, 2026): Pool.bracket and Bracket.matches being
// unbatched meant those 170 queries resolved in staggered waves gated by
// maxPoolSize:5, which in turn fragmented the ALREADY-loader-covered
// Match.player1/player2/winner/nextMatch/nextLoserMatch batching into ~17
// waves instead of 1 (each wave of matches arriving together, but different
// waves landing in different event-loop ticks). Fixing the upstream
// staggering here is what lets THOSE loaders batch the way they were always
// supposed to.
function batchMatchesByBracketId() {
  return async (bracketIds: readonly string[]): Promise<InstanceType<typeof Match>[][]> => {
    const matches = await Match.find({ bracketId: { $in: bracketIds as string[] } }).sort({
      bracketRound: 1,
      bracketPosition: 1,
    });
    const byBracketId = new Map<string, InstanceType<typeof Match>[]>();
    for (const m of matches) {
      const key = (m.bracketId as { toString(): string }).toString();
      if (!byBracketId.has(key)) byBracketId.set(key, []);
      byBracketId.get(key)!.push(m);
    }
    return bracketIds.map(id => byBracketId.get(id) ?? []);
  };
}

// Batches assertBracketMatchEditable's GRAND_FINAL_RESET lookup (one
// Match.findOne({bracketId, bracketSide:"GRAND_FINAL_RESET"}) per Grand
// Final match before this) into a single find({bracketId:{$in:...}}). Found
// while re-verifying the Pool.bracket/Bracket.matches fix above still left
// the real tournament detail page at ~20s -- Match.canUndo calls
// assertBracketMatchEditable for every COMPLETED bracket match (hundreds on
// an 85-pool tournament), and until now that function always did its own
// unbatched Match.findById/findOne calls regardless of caller, DataLoader-
// covered fields or not (85-pool tournament perf investigation, Aug 1,
// 2026). True 1:1 like batchBracketByPoolId -- a bracket has at most one
// Grand Final Reset match.
function batchGrandFinalResetByBracketId() {
  return async (bracketIds: readonly string[]): Promise<(InstanceType<typeof Match> | null)[]> => {
    const resets = await Match.find({ bracketId: { $in: bracketIds as string[] }, bracketSide: "GRAND_FINAL_RESET" });
    const byBracketId = new Map(resets.map(m => [(m.bracketId as { toString(): string }).toString(), m]));
    return bracketIds.map(id => byBracketId.get(id) ?? null);
  };
}

// Batches Pool.matches / Pool.standings' round-robin-matches check (one
// Match.find({poolId})/Match.exists({poolId}) per pool before this -- fires
// for every pool regardless of poolModel, even though it's only ever
// non-empty for Model A round-robin pools; Model B/C pools always got an
// unbatched query that just returned empty). Also used by isPoolComplete's
// round-robin branch below.
function batchPoolMatches() {
  return async (poolIds: readonly string[]): Promise<InstanceType<typeof Match>[][]> => {
    const matches = await Match.find({ poolId: { $in: poolIds as string[] } }).sort({ createdAt: 1 });
    const byPoolId = new Map<string, InstanceType<typeof Match>[]>();
    for (const m of matches) {
      const key = (m.poolId as { toString(): string }).toString();
      if (!byPoolId.has(key)) byPoolId.set(key, []);
      byPoolId.get(key)!.push(m);
    }
    return poolIds.map(id => byPoolId.get(id) ?? []);
  };
}

// Batches Tournament.pools / Tournament.allPoolsComplete /
// Tournament.modelBCurrentRoundComplete, which each independently did their
// own Pool.find({tournamentId}) -- and, via arePoolsComplete's per-pool
// isPoolComplete loop, effectively re-ran that same query once per pool on
// nested calls too. Not a scaling N+1 like poolBracketLoader/
// bracketMatchesLoader above (fixed small count regardless of pool count),
// but a free win once every caller shares one per-request cache keyed by
// tournamentId.
function batchPoolsByTournament() {
  return async (tournamentIds: readonly string[]): Promise<InstanceType<typeof Pool>[][]> => {
    const pools = await Pool.find({ tournamentId: { $in: tournamentIds as string[] } }).sort({ poolNumber: 1 });
    const byTournamentId = new Map<string, InstanceType<typeof Pool>[]>();
    for (const p of pools) {
      const key = (p.tournamentId as { toString(): string }).toString();
      if (!byTournamentId.has(key)) byTournamentId.set(key, []);
      byTournamentId.get(key)!.push(p);
    }
    return tournamentIds.map(id => byTournamentId.get(id) ?? []);
  };
}

export function createLoaders() {
  return {
    playerLoader: new DataLoader(batchById(Player)),
    matchLoader: new DataLoader(batchById(Match)),
    // Pool.entrants + Pool.standings' entrant lookups -- previously their own
    // Entrant.find({_id:{$in:...}}) per pool.
    entrantLoader: new DataLoader(batchById(Entrant)),
    // Model A (round-robin) pools only -- see batchPoolMatches above.
    poolMatchesLoader: new DataLoader(batchPoolMatches()),
    // See batchPoolsByTournament above.
    poolsByTournamentLoader: new DataLoader(batchPoolsByTournament()),
    // Entrant.tournament used to do its own Tournament.findById(parent.tournamentId)
    // right next to Entrant.player above (which WAS already batched) -- an
    // individual findOne per entrant, e.g. one per tournament on a player's
    // profile page (/players/[id], July 30, 2026 perf investigation).
    tournamentLoader: new DataLoader(batchById(Tournament)),
    // Tournament.address/logoUrl/twitchUrl each used to do their own
    // Event.findById(parent.eventId) -- N+1 across the tournaments list
    // (up to 1000 rows, one lookup per linked event) AND a redundant
    // triple-fetch of the SAME event on the tournament detail page (all
    // three fields requested at once). One loader, shared across all three
    // resolvers, fixes both.
    eventLoader: new DataLoader(batchById(Event)),
    // Pool.bracket + Bracket.matches (see the two batch functions above for
    // the full staggering explanation) -- fixed Aug 1, 2026.
    poolBracketLoader: new DataLoader(batchBracketByPoolId()),
    bracketMatchesLoader: new DataLoader(batchMatchesByBracketId()),
    grandFinalResetLoader: new DataLoader(batchGrandFinalResetByBracketId()),
    gameTournamentCountLoader: new DataLoader<string, number>(batchGameTournamentCounts()),
    eventTournamentStatsLoader: new DataLoader<string, { tournamentCount: number; gameCount: number }>(
      batchEventTournamentStats()
    ),
    // Batches every Player.isLiveOnTwitch / Event.isLiveOnTwitch field
    // resolver invoked within one GraphQL request into as few Get Streams
    // calls as lib/twitch.ts's own 100-per-call chunking requires — same
    // "field resolver fires once per item, DataLoader coalesces the actual
    // fetches" pattern as playerLoader/matchLoader above, just backed by an
    // external API instead of a DB query. Keyed by lowercased username
    // (callers are expected to pass it pre-lowercased and pre-filtered —
    // this loader is never given a null/empty key).
    twitchLiveLoader: new DataLoader<string, boolean>(async (usernames) => {
      const statuses = await getLiveStatuses(usernames);
      return usernames.map(u => statuses.get(u) ?? false);
    }),
  };
}

export type Loaders = ReturnType<typeof createLoaders>;
