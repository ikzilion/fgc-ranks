import { Schema, models, model } from "mongoose";

export enum TORequestStatus {
  PENDING = "PENDING",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
}

// A player's request for admin-granted Tournament Organizer (TO) status —
// same PENDING/APPROVED/REJECTED review-queue shape as models/Event.ts's
// approval flow. Approving sets User.isTO true (see approveTORequest); this
// document itself is just the request record, not the permission itself.
const TORequestSchema = new Schema(
  {
    playerId: { type: Schema.Types.ObjectId, ref: "Player", required: true },
    // Required (unlike `reason` below) — a way for the reviewing admin to
    // reach the requester outside the app if needed. Format validated in
    // the requestTOStatus resolver before this document is ever created.
    contactEmail: { type: String, required: true },
    // Optional short note the requester can leave for the reviewing admin.
    reason: { type: String, default: "" },
    status: {
      type: String,
      enum: Object.values(TORequestStatus),
      default: TORequestStatus.PENDING,
    },
    // Only set when status is REJECTED.
    rejectionReason: { type: String, default: "" },
    // Set the moment status leaves PENDING (approved or rejected) — the
    // 7-day re-request cooldown after a rejection is measured from this,
    // not createdAt (which is when the request was originally submitted).
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const TORequest = models.TORequest || model("TORequest", TORequestSchema);
