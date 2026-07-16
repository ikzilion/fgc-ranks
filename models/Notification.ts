// models/Notification.ts
import { Schema, models, model } from "mongoose";

export enum NotificationType {
  MATCH_REPORTED = "MATCH_REPORTED",
  TOURNAMENT_LIVE = "TOURNAMENT_LIVE",
  TOURNAMENT_ENDED = "TOURNAMENT_ENDED",
  PLAYER_JOINED = "PLAYER_JOINED",
}

const NotificationSchema = new Schema(
  {
    // Who this notification is for
    playerId: { type: Schema.Types.ObjectId, ref: "Player", required: true },
    type: { type: String, enum: Object.values(NotificationType), required: true },
    message: { type: String, required: true },
    // Optional link target, e.g. a tournament or match id, for click-through
    link: { type: String, default: "" },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

NotificationSchema.index({ playerId: 1, createdAt: -1 });

export const Notification = models.Notification || model("Notification", NotificationSchema);
