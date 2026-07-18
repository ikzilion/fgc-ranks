import { Schema, models, model } from "mongoose";

export enum TournamentStatus {
  UPCOMING = "UPCOMING",
  LIVE = "LIVE",
  ENDED = "ENDED",
}

const TournamentSchema = new Schema(
  {
    name: { type: String, required: true },
    game: { type: String, required: true },
    status: {
      type: String,
      enum: Object.values(TournamentStatus),
      default: TournamentStatus.UPCOMING,
    },
    // Cached count — updated when entrants join/leave
    entrantCount: { type: Number, default: 0 },
    // Players with management access to this specific tournament (create/edit
    // matches, change status, etc.) — distinct from the global ADMIN role.
    // The creator is automatically added as the first organizer.
    organizers: [{ type: Schema.Types.ObjectId, ref: "Player" }],
    startDate: { type: Date, required: true },
    endDate: { type: Date },
  },
  { timestamps: true }
);

export const Tournament = models.Tournament || model("Tournament", TournamentSchema);
