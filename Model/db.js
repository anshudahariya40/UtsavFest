const mongoose = require('mongoose');

const defaultMongoUri = 'mongodb://127.0.0.1:27017/utsavfest';

async function connectDB() {
    const uri = process.env.MONGODB_URI || defaultMongoUri;

    if (mongoose.connection.readyState === 1) {
        return mongoose;
    }

    try {
        await mongoose.connect(uri, {
            serverSelectionTimeoutMS: 5000,
        });

        console.log('MongoDB connected successfully.');
        return mongoose;
    } catch (error) {
        console.error('MongoDB connection failed. Falling back to in-memory storage.', error.message);
        return null;
    }
}

module.exports = {
    connectDB,
    mongoose,
    isConnected: () => mongoose.connection.readyState === 1,
};
