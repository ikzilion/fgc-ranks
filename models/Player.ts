import { Schema, models, model } from "mongoose";

const PlayerSchema = new Schema(
  {
    // Link back to the auth User account
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    tag: { type: String, required: true, unique: true },
    region: { type: String, default: "" },
    // Array of character names this player mains
    characters: { type: [String], default: [] },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    // Season points for the leaderboard ranking
    points: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Virtual computed field: winRate = wins / (wins + losses)
PlayerSchema.virtual("winRate").get(function () {
  const total = this.wins + this.losses;
  return total === 0 ? 0 : Math.round((this.wins / total) * 100) / 100;
});

export const Player = models.Player || model("Player", PlayerSchema);
