import { Schema, models, model } from "mongoose";

export enum MatchStatus {
  PENDING = "PENDING",
  IN_PROGRESS = "IN_PROGRESS",
  COMPLETED = "COMPLETED",
}

const MatchSchema = new Schema(
  {
    tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
    player1Id: { type: Schema.Types.ObjectId, ref: "Player", required: true },
    player2Id: { type: Schema.Types.ObjectId, ref: "Player", required: true },
    player1Score: { type: Number, default: 0 },
    player2Score: { type: Number, default: 0 },
    // Populated after reportResult mutation resolves the winner
    winnerId: { type: Schema.Types.ObjectId, ref: "Player" },
    // e.g. "Top 8", "Semifinals", "Grand Finals"
    round: { type: String, required: true },
    status: {
      type: String,
      enum: Object.values(MatchStatus),
      default: MatchStatus.PENDING,
    },
  },
  { timestamps: true }
);

export const Match = models.Match || model("Match", MatchSchema);
