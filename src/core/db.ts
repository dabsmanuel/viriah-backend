import mongoose, { type ClientSession } from 'mongoose';
import { env } from '../config/env';
import { logger } from './logger';

mongoose.set('strictQuery', true);
// Operators in user input never reach a query: stripOperators() runs on every body, query and params object,
// and every endpoint validates with a strict Zod schema (Document 3, section 13.1).

let txSupported = true;

export async function connectDb(uri = env.MONGODB_URI): Promise<typeof mongoose> {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  try {
    const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
    txSupported = Boolean(hello.setName) || hello.msg === 'isdbgrid';
  } catch {
    txSupported = false;
  }
  if (!txSupported) {
    logger.warn('MongoDB is not a replica set. Multi-document transactions are disabled. Run a replica set in staging and production.');
    if (env.APP_ENV === 'production') throw new Error('A MongoDB replica set is required in production (payments and rollover use transactions).');
  }
  return mongoose;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

export const transactionsSupported = () => txSupported;

/**
 * Run work in one database transaction (payments, enrolment, rollover). Mongoose does not attach the session
 * automatically: pass it to every operation. On a standalone dev database the work runs without a transaction.
 */
export async function tx<T>(fn: (session: ClientSession | undefined) => Promise<T>): Promise<T> {
  if (!txSupported) return fn(undefined);
  const session = await mongoose.startSession();
  try {
    let out!: T;
    await session.withTransaction(async () => {
      out = await fn(session);
    });
    return out;
  } finally {
    await session.endSession();
  }
}

/** Options object for operations that accept a session. */
export const sess = (session?: ClientSession) => (session ? { session } : {});

export async function syncIndexes() {
  for (const name of mongoose.modelNames()) await mongoose.model(name).syncIndexes();
}
