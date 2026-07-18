// models/Bracket.ts
import { Schema, models, model } from "mongoose";

export enum SeedingMethod {
  RANDOM = "RANDOM",
  RANDOM_WITHIN_TIERS = "RANDOM_WITHIN_TIERS",
  MANUAL = "MANUAL",
}

const BracketSchema = new Schema(
  {
    // 1:1 with Tournament — enforced via the unique index below.
    tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true, unique: true },
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

export const Bracket = models.Bracket || model("Bracket", BracketSchema);
