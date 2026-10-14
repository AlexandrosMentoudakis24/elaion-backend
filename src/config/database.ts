import { MongoClient, type Collection, type Db } from "mongodb";
import { loadConfig } from "./env.js";

export interface MongoContext {
  client: MongoClient;
  db: Db;
  collection<T extends object>(name: string): Collection<T>;
}

export const connectDatabase = async (
  uri?: string,
  dbName?: string,
): Promise<MongoContext> => {
  const config = loadConfig();
  const client = new MongoClient(uri ?? config.mongoUri, {
    maxPoolSize: 20,
    minPoolSize: 1,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
  });

  await client.connect();

  const db = client.db(dbName ?? config.mongoDbName);
  console.log(`Connected to MongoDB database "${db.databaseName}"`);

  return {
    client,
    db,
    collection: <T extends object>(name: string): Collection<T> => db.collection<T>(name),
  };
};

export const disconnectDatabase = async (context: MongoContext): Promise<void> => {
  await context.client.close();
  console.log("MongoDB connection closed");
};
