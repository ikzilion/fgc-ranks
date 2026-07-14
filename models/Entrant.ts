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
  },
  { timestamps: true }
);

// Prevent a player from registering twice in the same tournament
EntrantSchema.index({ playerId: 1, tournamentId: 1 }, { unique: true });

export const Entrant = models.Entrant || model("Entrant", EntrantSchema);
