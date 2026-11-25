const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { connectDB, mongoose, isConnected } = require('../Model/db');
const events = require('../Model/festivalModel1');
const users = require('../Model/userModel');

async function main() {
    try {
        await connectDB();
        if (!isConnected()) throw new Error('Database unavailable; no records were migrated.');
        const report = await events.migrateParticipationRelationships(await users.listUsersForAdmin());
        console.log('Participation migration:', JSON.stringify(report));
        console.log('Existing records are preserved. Ambiguous or unmatched records remain unchanged.');
    } finally {
        await mongoose.disconnect();
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
