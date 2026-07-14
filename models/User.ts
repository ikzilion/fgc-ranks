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
  },
  { timestamps: true }
);

export const User = models.User || model("User", UserSchema);
