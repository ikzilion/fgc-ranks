// scripts/checkInviteToTournamentLock.mjs
//
// One-off functional verification for a bug found during the tournament-loop
// QA walkthrough: inviteToTournament had no LIVE/ENDED status check, unlike
// joinTournament/addEntrantByOrganizer -- a TO could invite a player to a
// tournament that had already gone live or ended, and the invitee would get
// a "you've been invited to join" notification for something they could
// never actually join (joinTournament blocks LIVE/ENDED). Calls the REAL
// inviteToTournament resolver against real data in the actual database.
//
// Run: npx tsx scripts/checkInviteToTournamentLock.mjs

import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";

function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvLocal();
if (!process.env.MONGODB_URI) throw new Error("Missing MONGODB_URI (checked .env.local)");

const { connectToDatabase } = await import("../lib/db");
const { User } = await import("../models/User");
const { Player } = await import("../models/Player");
const { Tournament } = await import("../models/Tournament");
const { resolvers } = await import("../graphql/resolvers/index");

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  OK   ${label}`);
  } else {
    console.log(`  FAIL ${label}`);
    failures++;
  }
}

const PASSWORD_HASH_PROMISE = bcrypt.hash("TestPass123!", 10);
const createdTournamentIds = [];
const createdPlayerTags = [];

async function makeTestPlayer(tag) {
  const passwordHash = await PASSWORD_HASH_PROMISE;
  const email = `${tag.toLowerCase()}@example.com`;
  const user = await User.create({ email, passwordHash });
  const player = await Player.create({ userId: user._id, tag });
  await User.findByIdAndUpdate(user._id, { playerId: player._id });
  createdPlayerTags.push(tag);
  return player;
}

async function main() {
  await connectToDatabase();
  try {
    const organizer = await makeTestPlayer("InviteLockTO");
    const invitee = await makeTestPlayer("InviteLockInvitee");
    const organizerCtx = { playerId: organizer._id.toString(), role: undefined };

    const tournament = await Tournament.create({
      name: "QA Invite Lock Check",
      game: "QA Test Game",
      format: "Standard Bracket",
      status: "UPCOMING",
      organizers: [organizer._id],
      startDate: new Date(),
    });
    createdTournamentIds.push(tournament._id);

    // UPCOMING: invite should succeed.
    const invited = await resolvers.Mutation.inviteToTournament(null, { tournamentId: tournament._id.toString(), playerId: invitee._id.toString() }, organizerCtx);
    assert(invited.invitedPlayerIds.some(id => id.toString() === invitee._id.toString()), "UPCOMING: inviteToTournament succeeds and records the invite");

    // Cancel it so the LIVE check below starts clean.
    await resolvers.Mutation.cancelTournamentInvite(null, { tournamentId: tournament._id.toString(), playerId: invitee._id.toString() }, organizerCtx);

    // LIVE: invite must now be blocked.
    await resolvers.Mutation.updateTournamentStatus(null, { id: tournament._id.toString(), status: "LIVE" }, organizerCtx);
    let liveBlocked = false;
    try {
      await resolvers.Mutation.inviteToTournament(null, { tournamentId: tournament._id.toString(), playerId: invitee._id.toString() }, organizerCtx);
    } catch (err) {
      liveBlocked = true;
      assert(/live or has ended/.test(err.message), `LIVE: error message is the expected join-lock message (got "${err.message}")`);
    }
    assert(liveBlocked, "LIVE: inviteToTournament is correctly blocked (fixed bug)");

    // ENDED: invite must also be blocked.
    await resolvers.Mutation.updateTournamentStatus(null, { id: tournament._id.toString(), status: "ENDED" }, organizerCtx);
    let endedBlocked = false;
    try {
      await resolvers.Mutation.inviteToTournament(null, { tournamentId: tournament._id.toString(), playerId: invitee._id.toString() }, organizerCtx);
    } catch {
      endedBlocked = true;
    }
    assert(endedBlocked, "ENDED: inviteToTournament is correctly blocked (fixed bug)");

    console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURE(S)`}`);
  } finally {
    console.log("\nCleaning up test data...");
    for (const id of createdTournamentIds) await Tournament.findByIdAndDelete(id);
    const orgPlayers = await Player.find({ tag: { $in: createdPlayerTags } });
    const orgUserIds = orgPlayers.map(p => p.userId).filter(Boolean);
    await Player.deleteMany({ tag: { $in: createdPlayerTags } });
    await User.deleteMany({ _id: { $in: orgUserIds } });
    console.log("Cleanup done.");
  }
  process.exit(failures === 0 ? 0 : 1);
}

main();
