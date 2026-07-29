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
    // Pool format Model B only -- which repooling round this pool belongs to
    // (1 = the tournament's own first pool round). Always 1 for Model A/C,
    // which only ever have a single pool round; every pool created before
    // this field existed is genuinely a Model A/C round-1 pool, so the
    // default is correct for old documents too, not just new ones.
    // poolNumber itself stays a single tournament-wide counter across every
    // round rather than resetting per round (round 2's pools continue
    // numbering after round 1's last pool) -- avoids touching the existing
    // {tournamentId, poolNumber} unique index for a Model B tournament with
    // many rounds' worth of pools.
    roundNumber: { type: Number, default: 1 },
    // Pool format Model B only -- true for the final ~24-entrant Semifinal
    // round, whose own bracket is built by buildFinalsCutoffBracket instead
    // of a normal full double-elimination bracket (lib/bracket.ts) and so
    // has NO Grand Final of its own (see the Notion "Pool format Model B"
    // writeup's confirmed real EVO shape). isPoolComplete's Grand-Final-based
    // completion check doesn't apply to this pool -- see its own branch in
    // graphql/resolvers/index.ts.
    isFinalsCutoff: { type: Boolean, default: false },
    // Only set when isFinalsCutoff is true -- how to resolve each of the 8
    // real Finals qualifiers once this round's own matches are actually
    // played, exactly as buildFinalsCutoffBracket's own finalistSlots
    // determined at generation time: either a { kind: "PLAYER", playerId }
    // (a bye already resolved this slot with no match needed) or a
    // { kind: "PENDING", matchId } (read matchId's real winnerId once
    // COMPLETED). Stored rather than re-derived later because re-deriving
    // "which match is the terminal one for this finalist slot" purely from
    // bracketRound/nextMatchId after the fact is genuinely ambiguous once
    // byes are involved -- this is the exact mapping buildFinalsCutoffBracket
    // already computed once, at generation time, with zero ambiguity.
    finalsCutoffFinalistSpecs: { type: [Schema.Types.Mixed], default: undefined },
  },
  { timestamps: true }
);

PoolSchema.index({ tournamentId: 1, poolNumber: 1 }, { unique: true });

export const Pool = models.Pool || model("Pool", PoolSchema);
