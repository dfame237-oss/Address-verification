// scripts/migrate-add-credits.js
// Usage: node scripts/migrate-add-credits.js
// Ensure NODE_ENV and DB envs are set same as your server.

const { connectToDatabase } = require('../api/db'); // adjust path if needed
const { ObjectId } = require('mongodb');

function parseCreditsFromPlanValue(planValue) {
  if (!planValue || typeof planValue !== 'string') return null;
  const parts = planValue.split('_');
  const raw = parts[parts.length - 1] || '';
  if (String(raw).toLowerCase().includes('unlim')) return 'Unlimited';
  const numeric = parseInt(String(raw).replace(/,/g, ''), 10);
  return isNaN(numeric) ? null : numeric;
}

(async function main() {
  console.log('Starting migration: add initialCredits & remainingCredits to clients');
  let db;
  try {
    const dbRes = await connectToDatabase();
    db = dbRes.db;
  } catch (e) {
    console.error('DB connection failed:', e);
    process.exit(1);
  }

  const clients = db.collection('clients');

  try {
    const cursor = clients.find({});
    let updated = 0, processed = 0;
    while (await cursor.hasNext()) {
      const c = await cursor.next();
      processed++;
      const updates = {};
      // Add initialCredits if missing
      if (typeof c.initialCredits === 'undefined' || c.initialCredits === null) {
        const parsed = parseCreditsFromPlanValue(c.planName);
        updates.initialCredits = parsed === null ? 0 : parsed;
      }
      // Add remainingCredits if missing
      if (typeof c.remainingCredits === 'undefined' || c.remainingCredits === null) {
        updates.remainingCredits = updates.initialCredits === 'Unlimited' ? 'Unlimited' : updates.initialCredits;
      }
      // Ensure activeSessionId exists
      if (typeof c.activeSessionId === 'undefined') updates.activeSessionId = null;

      // Only perform update if we have keys
      if (Object.keys(updates).length > 0) {
        const result = await clients.updateOne({ _id: new ObjectId(c._id) }, { $set: updates });
        if (result.matchedCount) updated++;
      }
    }
    console.log(`Migration complete. Processed: ${processed}, Updated: ${updated}`);
    process.exit(0);
  } catch (e) {
    console.error('Migration error:', e);
    process.exit(2);
  }
})();
