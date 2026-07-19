import { Schema, models, model } from "mongoose";

const PlayerSchema = new Schema(
  {
    // Link back to the auth User account
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    tag: { type: String, required: true, unique: true },
    // Human-friendly sequential ID (displayed as e.g. "FGC-000001" — see
    // lib/playerId.ts for the formatter), assigned atomically via
    // lib/counter.ts on creation. Foundation for the separately-backlogged
    // QR-based tournament check-in feature. `sparse` so the unique index
    // tolerates older documents that haven't been backfilled yet.
    playerNumber: { type: Number, unique: true, sparse: true },
    region: { type: String, default: "" },
    avatarUrl: { type: String, default: "" },
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
