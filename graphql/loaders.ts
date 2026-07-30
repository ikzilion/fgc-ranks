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
import { getLiveStatuses } from "@/lib/twitch";

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
function batchGameTournamentCounts() {
  return async (names: readonly string[]): Promise<number[]> => {
    const rows = await Tournament.aggregate([
      { $match: { game: { $in: names as string[] } } },
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
      { $match: { eventId: { $in: objectIds } } },
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

export function createLoaders() {
  return {
    playerLoader: new DataLoader(batchById(Player)),
    matchLoader: new DataLoader(batchById(Match)),
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
