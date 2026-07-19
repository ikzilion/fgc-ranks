import { Counter } from "@/models/Counter";

// Atomically returns the next value for a named sequence, creating it
// starting at 1 the first time it's used. Callers must have already called
// connectToDatabase() — this mirrors every other lib helper's convention of
// not managing the connection itself.
export async function getNextSequence(name: string): Promise<number> {
  const counter = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return counter.seq;
}
