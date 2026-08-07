// scripts/deleteMatch.js
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

  const matchId = '6a56f1335f8ed6d48d2908c5';
  const result = await mongoose.connection.collection('matches').deleteOne({
    _id: new mongoose.Types.ObjectId(matchId),
  });

  console.log('Deleted count:', result.deletedCount);

  // Also correct MenaRD's stats — subtract the duplicate win and 100 points
  const playerResult = await mongoose.connection.collection('players').updateOne(
    { tag: 'MenaRD' },
    { $inc: { wins: -1, points: -100 } }
  );
  console.log('Player stats corrected:', playerResult.modifiedCount);

  // Also correct ikzilion's stats — subtract the duplicate loss
  const loserResult = await mongoose.connection.collection('players').updateOne(
    { tag: 'ikzilion' },
    { $inc: { losses: -1 } }
  );
  console.log('Loser stats corrected:', loserResult.modifiedCount);

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
