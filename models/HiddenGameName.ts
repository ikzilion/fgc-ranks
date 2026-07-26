import { Schema, models, model } from "mongoose";

// Admin management gap for uncurated game entries (settled July 26, 2026) --
// "Hide from list" persists here: an uncurated (orphan) Tournament.game
// string an admin has chosen to hide from the games list (junk like a
// literal "n/a" that isn't a real game and doesn't need "correcting", just
// needs to stop cluttering the list) -- WITHOUT creating a real Game
// document and WITHOUT touching any Tournament.game value. Its own tiny
// model rather than a field bolted onto Game, since a hidden orphan has no
// Game document to bolt a flag onto in the first place -- that's the whole
// point of "hide" as opposed to "curate" (see hideUncuratedGame/
// curateUncuratedGame in graphql/resolvers/index.ts).
const HiddenGameNameSchema = new Schema(
  {
    name: { type: String, required: true, unique: true },
  },
  { timestamps: true }
);

export const HiddenGameName = models.HiddenGameName || model("HiddenGameName", HiddenGameNameSchema);
