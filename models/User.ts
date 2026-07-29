import { Schema, models, model } from "mongoose";

export enum UserRole {
  PLAYER = "PLAYER",
  ADMIN = "ADMIN",
  // Single fixed account, bootstrapped via scripts/makeSuperAdmin.js — not
  // grantable in-app (see grantAdmin/revokeAdmin, which only ever move an
  // account between ADMIN and PLAYER). Has every ADMIN capability plus the
  // ability to grant/revoke ADMIN on other accounts — see lib/roles.ts.
  SUPER_ADMIN = "SUPER_ADMIN",
}

const UserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: Object.values(UserRole), default: UserRole.PLAYER },
    // Tournament Organizer status — a narrower, independent trust flag, NOT
    // part of the role hierarchy above (an isTO player gains only the
    // ability to create a "full" tournament, see createTournament; nothing
    // else ADMIN/SUPER_ADMIN can do). Granted via the request/approval flow
    // (models/TORequest.ts) or a direct admin grant — see
    // grantTOStatus/revokeTOStatus/approveTORequest.
    isTO: { type: Boolean, default: false },
    // Reference to the player profile linked to this account
    playerId: { type: Schema.Types.ObjectId, ref: "Player" },
    // Password reset flow — token is hashed (SHA-256) before storage, never plaintext
    resetTokenHash: { type: String, default: null },
    resetTokenExpiry: { type: Date, default: null },
    // Soft-delete (admin-triggered account deletion) — see deletePlayer
    // resolver. authorize() rejects login outright once this is true,
    // regardless of any credential.
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    // Email verification — default `true` so every account that predates
    // this feature (no field set in the DB at all) is grandfathered in as
    // already-verified without a backfill migration; `register` explicitly
    // sets this to `false` for new signups. authorize()/login check
    // `=== false` specifically (not falsy) so grandfathered legacy
    // documents, where this is `undefined`, are never rejected.
    emailVerified: { type: Boolean, default: true },
    // Same hashed-token-with-expiry pattern as resetTokenHash/resetTokenExpiry.
    emailVerificationTokenHash: { type: String, default: null },
    emailVerificationTokenExpiry: { type: Date, default: null },
    // Self-service account deletion — same hashed-token-with-expiry pattern
    // again, 1h expiry like password reset (also a sensitive action) rather
    // than email verification's longer 24h window. See
    // requestAccountDeletion/confirmAccountDeletion resolvers.
    deleteAccountTokenHash: { type: String, default: null },
    deleteAccountTokenExpiry: { type: Date, default: null },
    // Grace-period account deletion (settled July 28, 2026) -- replaces
    // confirmAccountDeletion's old "scrub immediately" behavior.
    // scheduledScrubAt null = not pending. Sign-in still works normally
    // during this window (see lib/auth.ts's authorize()) -- locking the
    // account out here would also block the "sign back in and cancel" path
    // the client offers alongside the emailed cancel link. See
    // lib/accountDeletion.ts for the grace-period length and how the
    // eventual scrub actually gets triggered (this app has no cron/
    // scheduled-job infrastructure -- same reasoning as lib/ranking.ts's
    // header comment -- so it's enforced lazily instead).
    pendingDeletionRequestedAt: { type: Date, default: null },
    scheduledScrubAt: { type: Date, default: null },
    // Cancel-from-email-link token -- separate from deleteAccountTokenHash/
    // Expiry above (that pair is the short-lived 1h request->confirm step);
    // this one needs to stay valid for the whole multi-day grace window.
    // Same hashed-token-with-expiry pattern.
    cancelDeletionTokenHash: { type: String, default: null },
    cancelDeletionTokenExpiry: { type: Date, default: null },
    // Restore window (settled July 28, 2026) -- softDeletePlayer
    // (lib/accountDeletion.ts) retains the real email here for
    // SCRUB_BACKUP_RETENTION_MS after a scrub, so a Super Admin can undo an
    // unauthorized/mistaken deletion via restoreDeletedPlayer. Purged
    // (along with Player.scrubBackupTag) once the retention window elapses
    // -- same lazy, no-cron enforcement as the grace period above.
    scrubBackupEmail: { type: String, default: null },
    scrubBackupExpiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Sparse -- almost every document has these unset (null), and the only
// real query against them is "find the ones that are due" (lib/accountDeletion.ts's
// lazy maintenance sweep, run on every GraphQL request), which only cares
// about the small non-null subset.
UserSchema.index({ scheduledScrubAt: 1 }, { sparse: true });
UserSchema.index({ scrubBackupExpiresAt: 1 }, { sparse: true });

export const User = models.User || model("User", UserSchema);
