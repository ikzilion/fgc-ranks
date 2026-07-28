import { Schema, models, model } from "mongoose";

// Simple audit trail for the account-deletion grace-period feature (settled
// July 28, 2026, see the Notion "Account deletion is currently
// unrecoverable" writeup) -- a real record of who/when/IP for deletion
// requests, cancellations, and the eventual real scrub, so there's
// something to check against if a deletion ever looks suspicious (e.g. a
// compromised account). Intentionally minimal -- plain fields, no separate
// query/viewer UI built for it in this pass (per the settled "no need for
// anything fancier" scope); read directly from the DB if ever needed.
export enum AccountDeletionAuditAction {
  // requestAccountDeletion — confirmation email sent.
  REQUESTED = "REQUESTED",
  // confirmAccountDeletion — the 7-day grace period actually starts here
  // (this used to be the immediate-scrub step, before the grace period
  // existed).
  CONFIRMED = "CONFIRMED",
  // cancelAccountDeletion (email-link token) or cancelMyPendingDeletion
  // (signed-in session) — either path logs the same action.
  CANCELLED = "CANCELLED",
  // softDeletePlayer actually ran -- via the grace period elapsing
  // (lazily, see lib/accountDeletion.ts), or the ADMIN deletePlayer
  // mutation's immediate path. performedByPlayerId on this entry
  // distinguishes an admin-triggered scrub from the account's own elapsed
  // window.
  SCRUBBED = "SCRUBBED",
  // restoreDeletedPlayer -- always admin-triggered, performedByPlayerId is
  // the Super Admin who did it.
  RESTORED = "RESTORED",
}

const AccountDeletionAuditLogSchema = new Schema(
  {
    playerId: { type: Schema.Types.ObjectId, ref: "Player", required: true },
    action: { type: String, enum: Object.values(AccountDeletionAuditAction), required: true },
    ip: { type: String, default: "unknown" },
    // Who performed the action, when it wasn't the account itself acting on
    // its own behalf -- the admin for an ADMIN-triggered SCRUBBED or a
    // RESTORED entry. null for every self-service action (REQUESTED/
    // CONFIRMED/CANCELLED) and for a SCRUBBED entry from the grace period
    // simply elapsing (nobody "did" that one, the window just ran out).
    performedByPlayerId: { type: Schema.Types.ObjectId, ref: "Player", default: null },
  },
  { timestamps: true }
);

AccountDeletionAuditLogSchema.index({ playerId: 1, createdAt: -1 });

export const AccountDeletionAuditLog = models.AccountDeletionAuditLog || model("AccountDeletionAuditLog", AccountDeletionAuditLogSchema);
