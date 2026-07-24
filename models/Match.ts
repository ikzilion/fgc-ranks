import { Schema, models, model } from "mongoose";

export enum MatchStatus {
  PENDING = "PENDING",
  IN_PROGRESS = "IN_PROGRESS",
  COMPLETED = "COMPLETED",
}

// A bracket match belongs to one side of a double-elimination bracket.
// GRAND_FINAL_RESET only exists if the losers-side finalist wins game 1.
export enum BracketSide {
  WINNERS = "WINNERS",
  LOSERS = "LOSERS",
  GRAND_FINAL = "GRAND_FINAL",
  GRAND_FINAL_RESET = "GRAND_FINAL_RESET",
}

const MatchSchema = new Schema(
  {
    tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
    // Not required at the schema level: bracket matches are created with one
    // or both slots TBD (null) until a feeder match resolves.
    player1Id: { type: Schema.Types.ObjectId, ref: "Player" },
    player2Id: { type: Schema.Types.ObjectId, ref: "Player" },
    player1Score: { type: Number, default: 0 },
    player2Score: { type: Number, default: 0 },
    // Populated after reportResult mutation resolves the winner
    winnerId: { type: Schema.Types.ObjectId, ref: "Player" },
    // True when this result came from a forfeit rather than a played score —
    // the UI shows "FF" instead of player1Score/player2Score (left at their
    // 0 defaults). The forfeiting player is just whichever of player1/player2
    // isn't winnerId — no separate field needed to track that.
    isForfeit: { type: Boolean, default: false },
    // e.g. "Top 8", "Semifinals", "Grand Finals" — bracket matches get an
    // auto-generated label (see lib/bracket.ts) instead of a free-text one.
    round: { type: String, required: true },
    status: {
      type: String,
      enum: Object.values(MatchStatus),
      default: MatchStatus.PENDING,
    },
    // ── Bracket fields — every Match is a bracket match now that the
    // freeform (manual, non-bracket) match system has been removed ──
    bracketId: { type: Schema.Types.ObjectId, ref: "Bracket" },
    bracketSide: { type: String, enum: Object.values(BracketSide) },
    bracketRound: { type: Number },
    bracketPosition: { type: Number },
    // Where this match's winner/loser advance to, if anywhere.
    nextMatchId: { type: Schema.Types.ObjectId, ref: "Match" },
    nextMatchSlot: { type: Number }, // 1 or 2 — which player slot on nextMatch
    nextLoserMatchId: { type: Schema.Types.ObjectId, ref: "Match" },
    nextLoserMatchSlot: { type: Number },
    // Pool format Model A only — round-robin pool matches have no bracket
    // structure to wire into (no bracketId/bracketSide/next*MatchId; every
    // match is independent, nothing "advances" anywhere), so this is the
    // only way to trace a match back to its Pool. Lets Pool.matches/
    // Pool.standings query directly by poolId instead of needing a Bracket
    // document, which a round-robin pool never has. null for every
    // bracket match (those use bracketId instead).
    poolId: { type: Schema.Types.ObjectId, ref: "Pool" },
  },
  { timestamps: true }
);

export const Match = models.Match || model("Match", MatchSchema);
