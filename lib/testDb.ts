// lib/testDb.ts
// In-memory MongoDB for local dev/testing without a real Atlas account.
// Usage: set MONGODB_URI=memory in .env.local and this module intercepts
// the connection and spins up MongoMemoryServer instead.

import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod: MongoMemoryServer | null = null;

export async function startMemoryDb() {
  if (mongoose.connection.readyState === 1) return; // already connected

  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);
  console.log("[testDb] In-memory MongoDB started at", uri);
}

export async function stopMemoryDb() {
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  if (mongod) await mongod.stop();
  console.log("[testDb] In-memory MongoDB stopped");
}
