import { Schema, models, model } from "mongoose";

export enum UserRole {
  PLAYER = "PLAYER",
  ADMIN = "ADMIN",
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
