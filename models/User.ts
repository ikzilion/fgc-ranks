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
  },
  { timestamps: true }
);

export const User = models.User || model("User", UserSchema);
