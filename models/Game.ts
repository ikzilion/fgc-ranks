import { Schema, models, model } from "mongoose";

// Curated list of games a tournament can be created under (see the "Games"
// nav tab / app/games). Tournament.game itself stays a plain free-text
// string, unchanged — this is only the source of truth for what the
// creation dropdown offers and what gets its own browsable Games-list card.
// A tournament whose game string doesn't match any curated name here (drift,
// or before this Game ever existed) still surfaces on the Games list as its
// own synthetic entry — see the `games` resolver — so nothing ever silently
// disappears from browsing just because it isn't curated (yet).
const GameSchema = new Schema(
  {
    name: { type: String, required: true, unique: true },
    // Empty = no icon uploaded yet — UI falls back to a generic initials
    // placeholder, same convention as Player.avatarUrl/Event.logoUrl.
    iconUrl: { type: String, default: "" },
  },
  { timestamps: true }
);

export const Game = models.Game || model("Game", GameSchema);
