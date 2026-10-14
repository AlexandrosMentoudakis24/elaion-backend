import { connectDatabase, disconnectDatabase } from "../config/database.js";
import { Collections } from "../models/index.js";

console.log("Migration script loaded (no-op)");

const database = await connectDatabase();
await disconnectDatabase(database);
console.log("Migration complete");