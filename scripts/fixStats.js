// scripts/fixStats.js
// One-time correction: set exact stat values instead of incrementing,
// since the duplicate-match cleanup over-corrected.
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

function loadMongoUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;

  const envPath = path.join(__dirname, '..', '.env.local');
  const contents = fs.readFileSync(envPath, 'utf8');
  const match = contents.match(/^MONGODB_URI=(.*)$/m);
  if (!match) {
    throw new Error('MONGODB_URI not found in .env.local');
  }
  return match[1].trim();
}

async function main() {
  const uri = loadMongoUri();

  await mongoose.connect(uri);

  // MenaRD should have exactly 1 win, 0 losses, 100 points (1 completed match, won 3-0)
  await mongoose.connection.collection('players').updateOne(
    { tag: 'MenaRD' },
    { $set: { wins: 1, losses: 0, points: 100 } }
  );

  // ikzilion should have exactly 0 wins, 1 loss, 0 points
  await mongoose.connection.collection('players').updateOne(
    { tag: 'ikzilion' },
    { $set: { wins: 0, losses: 1, points: 0 } }
  );

  // JotaroStarPlatinum untouched — 0 wins, 0 losses, 0 points (never played)
  await mongoose.connection.collection('players').updateOne(
    { tag: 'JotaroStarPlatinum' },
    { $set: { wins: 0, losses: 0, points: 0 } }
  );

  console.log('Stats corrected to reflect exactly 1 completed match (MenaRD beat ikzilion 3-0).');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
