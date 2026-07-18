import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI;

// Reuse the connection across hot reloads in dev so we don't open a new
// one on every file change (Next.js clears the module cache but not `global`).
declare global {
  var mongooseConn: Promise<typeof mongoose> | undefined;
}

export function connectToDatabase() {
  if (!MONGODB_URI) {
    throw new Error("Missing MONGODB_URI environment variable");
  }

  if (!global.mongooseConn) {
    // Clear the cache on failure so the next call retries instead of
    // replaying the same dead connection forever.
    global.mongooseConn = mongoose.connect(MONGODB_URI).catch((err) => {
      global.mongooseConn = undefined;
      throw err;
    });
  }

  return global.mongooseConn;
}
