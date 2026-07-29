import { Schema, models, model } from "mongoose";

// Generic atomic-sequence counter — one document per named sequence (e.g.
// "playerNumber"). findOneAndUpdate's $inc is atomic at the document level,
// so concurrent callers each get a distinct, gap-free next value with no
// race condition, unlike deriving a number from Player.countDocuments().
const CounterSchema = new Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

export const Counter = models.Counter || model("Counter", CounterSchema);
