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
import { Player } from "@/models/Player";
import { Match } from "@/models/Match";

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

export function createLoaders() {
  return {
    playerLoader: new DataLoader(batchById(Player)),
    matchLoader: new DataLoader(batchById(Match)),
  };
}

export type Loaders = ReturnType<typeof createLoaders>;
