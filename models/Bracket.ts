// models/Bracket.ts
import { Schema, models, model } from "mongoose";

export enum SeedingMethod {
  RANDOM = "RANDOM",
  RANDOM_WITHIN_TIERS = "RANDOM_WITHIN_TIERS",
  MANUAL = "MANUAL",
  // Pool play + top-cut only — main-bracket seeding that keeps each pool's
  // two advancers apart until later rounds (see lib/bracket.ts's
  // computeMainBracketSeedOrder). Never used for a standard tournament's
  // only bracket or for a pool's own internal bracket.
  AVOID_SAME_POOL = "AVOID_SAME_POOL",
}

const BracketSchema = new Schema(
  {
    // Was 1:1 with Tournament (enforced via a plain unique index) before
    // pool play — a "Pools + Bracket" tournament now has one Bracket per
    // Pool PLUS one main-bracket Bracket, all sharing the same
    // tournamentId. The partial index below preserves the original 1:1
    // invariant for every Bracket that ISN'T pool-scoped (poolId: null) —
    // i.e. a standard tournament's only bracket, or a pools tournament's
    // main bracket — while poolId's own partial unique index (see below)
    // caps each pool at one bracket.
    tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
    // null = this is a standard tournament's bracket, or a "Pools + Bracket"
    // tournament's main/2nd-stage bracket. Set = this bracket belongs to
    // that specific Pool.
    poolId: { type: Schema.Types.ObjectId, ref: "Pool", default: null },
    seedingMethod: { type: String, enum: Object.values(SeedingMethod), required: true },
    // Ordered player IDs, seed 1..N (index 0 = seed 1). Kept for the
    // "Seeded: ..." label and so future public/stream views can show seed
    // numbers without re-deriving them.
    seedOrder: [{ type: Schema.Types.ObjectId, ref: "Player" }],
    // Bracket size = next power of two >= entrant count (the gap is byes).
    size: { type: Number, required: true },
  },
  { timestamps: true }
);

BracketSchema.index({ tournamentId: 1 }, { unique: true, partialFilterExpression: { poolId: null } });
// NOT `sparse: true` — sparse only excludes a field that's genuinely
// MISSING from the document, not one explicitly set to null, and every
// Bracket created going forward has poolId: null written explicitly (the
// schema default). A sparse unique index would still collide across every
// non-pool bracket (the exact bug this partial index replaced — confirmed
// via the Pool play feature's functional test, which failed generating a
// second tournament's main bracket with an E11000 on poolId: null before
// this fix). $type: "objectId" is the supported partialFilterExpression
// operator that actually excludes both missing and explicit-null values.
BracketSchema.index({ poolId: 1 }, { unique: true, partialFilterExpression: { poolId: { $type: "objectId" } } });

export const Bracket = models.Bracket || model("Bracket", BracketSchema);
