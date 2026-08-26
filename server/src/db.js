import pg from "pg";
const { Pool } = pg;
export function createPool(connectionString=process.env.DATABASE_URL){if(!connectionString)throw new Error("DATABASE_URL 환경변수가 필요합니다.");const isLocal=/localhost|127\.0\.0\.1/.test(connectionString);return new Pool({connectionString,ssl:isLocal?false:{rejectUnauthorized:false},max:5,idleTimeoutMillis:30000})}
export async function migrate(pool){await pool.query(`CREATE TABLE IF NOT EXISTS journal_entries (id UUID PRIMARY KEY,firebase_uid TEXT NOT NULL,content VARCHAR(60) NOT NULL CHECK (char_length(content) BETWEEN 1 AND 60),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());CREATE INDEX IF NOT EXISTS journal_entries_owner_date_idx ON journal_entries (firebase_uid,created_at DESC);`)}
