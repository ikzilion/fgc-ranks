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
  },
  { timestamps: true }
);

export const User = models.User || model("User", UserSchema);
