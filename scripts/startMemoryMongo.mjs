// Standalone in-memory MongoDB for local verification runs.
//
// lib/testDb.ts describes a "MONGODB_URI=memory" interception, but lib/db.ts
// never actually implements it — so this starts a real MongoMemoryServer on a
// fixed port and stays alive, letting a normal `npm run dev` and a test
// script both point at it via MONGODB_URI. Lets security/functional tests run
// against a real server + real Mongoose models with zero production data and
// zero real credentials involved.
//
// Run: npx tsx scripts/startMemoryMongo.mjs   (leave running)
// Then: MONGODB_URI=mongodb://127.0.0.1:27018/fgc-ranks npm run dev

import { MongoMemoryServer } from "mongodb-memory-server";

const PORT = Number(process.env.MEMORY_MONGO_PORT ?? 27018);

const mongod = await MongoMemoryServer.create({
  instance: { port: PORT, dbName: "fgc-ranks" },
});

console.log(`[memory-mongo] ready at ${mongod.getUri()}`);
console.log(`[memory-mongo] MONGODB_URI=mongodb://127.0.0.1:${PORT}/fgc-ranks`);

const shutdown = async () => {
  await mongod.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Keep the process alive.
setInterval(() => {}, 1 << 30);
