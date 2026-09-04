import pg from "pg";

const { Pool } = pg;

export function createPool(
  connectionString = process.env.DATABASE_URL,
) {
  if (!connectionString) {
    throw new Error("DATABASE_URL 환경변수가 필요합니다.");
  }

  const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
  return new Pool({
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
  });
}

/**
 * Create all tables used by both the original personal diary and the shared
 * diary MVP. Every statement is intentionally idempotent so Render can run
 * the migration on every boot without changing existing data.
 *
 * A member slot is part of the primary key and is unique per room. This gives
 * the two-member limit a database-level guarantee in addition to the
 * transaction checks in the API (slot 1 is always the owner, slot 2 the
 * invited member).
 */
export async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS journal_entries (
      id UUID PRIMARY KEY,
      firebase_uid TEXT NOT NULL,
      content VARCHAR(60) NOT NULL CHECK (char_length(content) BETWEEN 1 AND 60),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS journal_entries_owner_date_idx
      ON journal_entries (firebase_uid, created_at DESC);

    CREATE TABLE IF NOT EXISTS journal_entry_meta (
      entry_id UUID PRIMARY KEY REFERENCES journal_entries(id) ON DELETE CASCADE,
      entry_date DATE,
      mood_emoji VARCHAR(16),
      mood_color VARCHAR(20),
      is_public BOOLEAN NOT NULL DEFAULT FALSE,
      CHECK (mood_color IS NULL OR mood_color IN ('sage', 'blue', 'yellow', 'orange', 'rose', 'lavender'))
    );
    CREATE INDEX IF NOT EXISTS journal_entry_meta_date_idx
      ON journal_entry_meta (entry_date DESC);
    CREATE INDEX IF NOT EXISTS journal_entry_meta_public_idx
      ON journal_entry_meta (is_public, entry_date DESC);

    CREATE TABLE IF NOT EXISTS user_prompt_preferences (
      firebase_uid TEXT PRIMARY KEY,
      categories TEXT[] NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public_profiles (
      firebase_uid TEXT PRIMARY KEY,
      display_name VARCHAR(40) NOT NULL,
      photo_url TEXT,
      discoverable BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS public_profiles_discoverable_name_idx
      ON public_profiles (discoverable, display_name);

    CREATE TABLE IF NOT EXISTS follow_requests (
      id UUID PRIMARY KEY,
      follower_uid TEXT NOT NULL,
      following_uid TEXT NOT NULL,
      status VARCHAR(10) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'rejected')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (follower_uid <> following_uid),
      UNIQUE (follower_uid, following_uid)
    );
    CREATE INDEX IF NOT EXISTS follow_requests_incoming_idx
      ON follow_requests (following_uid, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS follow_requests_outgoing_idx
      ON follow_requests (follower_uid, status, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS follow_requests_pair_idx
      ON follow_requests (LEAST(follower_uid, following_uid), GREATEST(follower_uid, following_uid));

    CREATE TABLE IF NOT EXISTS diary_rooms (
      id UUID PRIMARY KEY,
      owner_uid TEXT NOT NULL,
      name VARCHAR(120) NOT NULL DEFAULT '우리의 하루',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS diary_rooms_owner_idx
      ON diary_rooms (owner_uid, created_at DESC);

    CREATE TABLE IF NOT EXISTS diary_members (
      room_id UUID NOT NULL REFERENCES diary_rooms(id) ON DELETE CASCADE,
      firebase_uid TEXT NOT NULL,
      role VARCHAR(10) NOT NULL CHECK (role IN ('owner', 'member')),
      member_slot SMALLINT NOT NULL CHECK (member_slot IN (1, 2)),
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (room_id, firebase_uid),
      UNIQUE (room_id, member_slot),
      UNIQUE (room_id, role)
    );
    CREATE INDEX IF NOT EXISTS diary_members_user_idx
      ON diary_members (firebase_uid, joined_at DESC);

    CREATE TABLE IF NOT EXISTS diary_invites (
      room_id UUID PRIMARY KEY REFERENCES diary_rooms(id) ON DELETE CASCADE,
      token_hash CHAR(64) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS shared_diary_entries (
      id UUID PRIMARY KEY,
      room_id UUID NOT NULL,
      firebase_uid TEXT NOT NULL,
      entry_date DATE NOT NULL,
      content VARCHAR(60) NOT NULL
        CHECK (char_length(content) BETWEEN 1 AND 60),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (room_id, firebase_uid)
        REFERENCES diary_members(room_id, firebase_uid)
        ON DELETE CASCADE,
      UNIQUE (room_id, firebase_uid, entry_date)
    );
    CREATE INDEX IF NOT EXISTS shared_diary_entries_room_date_idx
      ON shared_diary_entries (room_id, entry_date DESC, updated_at DESC);
  `);
}
