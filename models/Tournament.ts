import { Schema, models, model } from "mongoose";

export enum TournamentStatus {
  UPCOMING = "UPCOMING",
  LIVE = "LIVE",
  ENDED = "ENDED",
  CANCELLED = "CANCELLED",
}

export enum TournamentVisibility {
  PUBLIC = "PUBLIC",
  PRIVATE = "PRIVATE",
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
    // Only set when status is CANCELLED — shown on the tournament card/listing.
    cancellationReason: { type: String },
    // PUBLIC = listed and open to join (default, existing behavior).
    // PRIVATE = still visible on the list (locked, not hidden), but joining
    // requires an accepted invite from an organizer.
    visibility: {
      type: String,
      enum: Object.values(TournamentVisibility),
      default: TournamentVisibility.PUBLIC,
    },
    // Players invited to a PRIVATE tournament who haven't accepted (joined)
    // or declined yet. Cleared once a player joins or declines.
    invitedPlayerIds: [{ type: Schema.Types.ObjectId, ref: "Player" }],
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
