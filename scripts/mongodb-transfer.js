const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const defaultMongoUri = 'mongodb://127.0.0.1:27017/utsavfest';
const backupPath = path.resolve(
    process.argv[3] || path.join(__dirname, '..', 'database-backup', 'utsavfest-backup.json')
);
const EJSON = mongoose.mongo.BSON.EJSON;

async function connect() {
    await mongoose.connect(process.env.MONGODB_URI || defaultMongoUri, {
        serverSelectionTimeoutMS: 5000
    });
    return mongoose.connection.db;
}

async function exportDatabase() {
    const db = await connect();
    const collectionInfos = await db.listCollections({}, { nameOnly: false }).toArray();
    const collections = [];

    for (const info of collectionInfos.filter((collection) =>
        collection.type === 'collection' && !collection.name.startsWith('system.')
    )) {
        const collection = db.collection(info.name);
        const documents = await collection.find({}).toArray();
        const indexes = (await collection.indexes()).filter((index) => index.name !== '_id_');

        collections.push({
            name: info.name,
            indexes,
            documents
        });
    }

    const backup = {
        format: 'utsavfest-mongodb-backup',
        version: 1,
        database: db.databaseName,
        createdAt: new Date(),
        collections
    };

    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    const temporaryPath = `${backupPath}.tmp`;
    fs.writeFileSync(temporaryPath, EJSON.stringify(backup, null, 2, { relaxed: false }), {
        flag: 'w'
    });
    fs.renameSync(temporaryPath, backupPath);

    console.log(`Backup saved to: ${backupPath}`);
    console.log(`Database: ${db.databaseName}`);
    for (const collection of collections) {
        console.log(`${collection.name}: ${collection.documents.length} records`);
    }
}

async function importDatabase() {
    if (!fs.existsSync(backupPath)) {
        throw new Error(`Backup file not found: ${backupPath}. Export it from the old PC first.`);
    }

    const backup = EJSON.parse(fs.readFileSync(backupPath, 'utf8'));
    if (
        backup.format !== 'utsavfest-mongodb-backup' ||
        backup.version !== 1 ||
        !Array.isArray(backup.collections) ||
        backup.collections.some((item) =>
            !item ||
            typeof item.name !== 'string' ||
            !Array.isArray(item.documents) ||
            !Array.isArray(item.indexes)
        )
    ) {
        throw new Error('The backup file is not a supported UtsavFest MongoDB backup.');
    }

    const db = await connect();
    if (db.databaseName !== backup.database) {
        throw new Error(
            `Backup is for "${backup.database}", but MONGODB_URI targets "${db.databaseName}".`
        );
    }

    const existingCollections = await db.listCollections({}, { nameOnly: true }).toArray();
    for (const info of existingCollections) {
        const count = await db.collection(info.name).countDocuments();
        if (count > 0) {
            throw new Error(
                `Import stopped: "${db.databaseName}.${info.name}" already contains records. ` +
                'Use a fresh database so existing data is not overwritten.'
            );
        }
    }

    for (const item of backup.collections) {
        let collection;
        if (existingCollections.some((info) => info.name === item.name)) {
            collection = db.collection(item.name);
        } else {
            collection = await db.createCollection(item.name);
        }

        if (item.documents.length) {
            await collection.insertMany(item.documents, { ordered: true });
        }

        const indexes = item.indexes
            .filter((index) => index && index.key && index.name !== '_id_')
            .map(({ v, ns, ...index }) => index);
        if (indexes.length) {
            await collection.createIndexes(indexes);
        }

        console.log(`${item.name}: imported ${item.documents.length} records`);
    }

    console.log(`Import complete. Database "${db.databaseName}" is ready.`);
}

async function main() {
    const action = process.argv[2];
    if (!['export', 'import'].includes(action)) {
        throw new Error('Usage: node scripts/mongodb-transfer.js <export|import> [backup-file]');
    }

    if (action === 'export') {
        await exportDatabase();
    } else {
        await importDatabase();
    }
}

main()
    .catch((error) => {
        console.error(`MongoDB ${process.argv[2] || 'transfer'} failed: ${error.message}`);
        process.exitCode = 1;
    })
    .finally(async () => {
        if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect();
        }
    });
