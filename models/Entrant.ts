import { Schema, models, model } from "mongoose";

// Entrant is the join collection between Player and Tournament.
// It stores the player's seed going in and their final placement.
const EntrantSchema = new Schema(
  {
    playerId: { type: Schema.Types.ObjectId, ref: "Player", required: true },
    tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
    // Seed assigned before the tournament starts (1 = top seed)
    seed: { type: Number },
    // Final placement after the tournament ends (1 = champion)
    placement: { type: Number },
    // True once a TO has set this entrant's placement directly via
    // setPlacement — marks it as a manual override so the automatic
    // bracket-placement logic (lib/bracket.ts) never overwrites it, even if
    // it re-runs later (e.g. an editMatchResult correction on the Grand
    // Final re-triggers advancement).
    placementSetManually: { type: Boolean, default: false },
    // Day-of attendance confirmation, distinct from joining — set once by
    // checkInEntrant (self or TO/admin), never cleared. A timestamp rather
    // than a plain boolean since arrival order is useful to a TO reviewing
    // who's actually shown up, not just a yes/no.
    checkedInAt: { type: Date },
  },
  { timestamps: true }
);

// Prevent a player from registering twice in the same tournament. Covers
// playerId-only queries too (Player.tournaments, lib/ranking.ts) since
// playerId is the compound prefix -- but NOT tournamentId-only queries
// (Tournament.entrants and friends), since tournamentId isn't the prefix.
EntrantSchema.index({ playerId: 1, tournamentId: 1 }, { unique: true });

// Added alongside the above rather than reordering it -- confirmed via
// explain() that Entrant.find({tournamentId}) ran as a COLLSCAN (see the
// Notion "FGC Ranks — Claude Context" page's Phase 7 follow-up); this is the
// far more common query shape across the resolvers (every tournament page
// load) than a playerId-only lookup.
EntrantSchema.index({ tournamentId: 1 });

export const Entrant = models.Entrant || model("Entrant", EntrantSchema);
