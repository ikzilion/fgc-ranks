// models/Pool.ts
import { Schema, models, model } from "mongoose";

// One pool within a "Pools + Bracket" tournament — a subset of the
// tournament's existing Entrant records (Entrant itself is never duplicated;
// see the Pool play + top-cut Implementation Plan). Each Pool gets its own
// Bracket document (models/Bracket.ts, poolId set), generated via the exact
// same double-elimination generator a standard tournament uses.
const PoolSchema = new Schema(
  {
    tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
    poolNumber: { type: Number, required: true }, // 1-indexed, for display ("Pool 1", "Pool 2", ...)
    entrantIds: [{ type: Schema.Types.ObjectId, ref: "Entrant", required: true }],
  },
  { timestamps: true }
);

PoolSchema.index({ tournamentId: 1, poolNumber: 1 }, { unique: true });

export const Pool = models.Pool || model("Pool", PoolSchema);
