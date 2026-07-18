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
    // or both slots TBD (null) until a feeder match resolves. The freeform
    // createMatch resolver still always supplies both up front.
    player1Id: { type: Schema.Types.ObjectId, ref: "Player" },
    player2Id: { type: Schema.Types.ObjectId, ref: "Player" },
    player1Score: { type: Number, default: 0 },
    player2Score: { type: Number, default: 0 },
    // Populated after reportResult mutation resolves the winner
    winnerId: { type: Schema.Types.ObjectId, ref: "Player" },
    // e.g. "Top 8", "Semifinals", "Grand Finals" — bracket matches get an
    // auto-generated label (see lib/bracket.ts) instead of a free-text one.
    round: { type: String, required: true },
    status: {
      type: String,
      enum: Object.values(MatchStatus),
      default: MatchStatus.PENDING,
    },
    // ── Bracket fields — undefined for freeform (non-bracket) matches ──
    bracketId: { type: Schema.Types.ObjectId, ref: "Bracket" },
    bracketSide: { type: String, enum: Object.values(BracketSide) },
    bracketRound: { type: Number },
    bracketPosition: { type: Number },
    // Where this match's winner/loser advance to, if anywhere.
    nextMatchId: { type: Schema.Types.ObjectId, ref: "Match" },
    nextMatchSlot: { type: Number }, // 1 or 2 — which player slot on nextMatch
    nextLoserMatchId: { type: Schema.Types.ObjectId, ref: "Match" },
    nextLoserMatchSlot: { type: Number },
  },
  { timestamps: true }
);

export const Match = models.Match || model("Match", MatchSchema);
