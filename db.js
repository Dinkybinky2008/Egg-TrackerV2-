import pkg from "pg";
const { Pool } = pkg;

let pool = null;

export function initDb() {
  if (pool) return pool;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL missing");

  pool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false }
  });

  return pool;
}

export async function ensureTables() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        guild_id TEXT PRIMARY KEY,
        webhook_channel_id TEXT,
        timezone_offset TEXT,
        loss_multiplier REAL DEFAULT 1.0
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS hatch_logs (
        id SERIAL PRIMARY KEY,
        guild_id TEXT,
        egg_name TEXT,
        weight REAL,
        rarity TEXT,
        hatched_at TIMESTAMP WITH TIME ZONE DEFAULT now()
      );
    `);
  } finally {
    client.release();
  }
}

export function getPool() {
  return pool;
}
