import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createApp } from "../src/app.js";
import { migrate } from "../src/db.js";

const ownerId = "owner-user";
const friendId = "friend-user";
const otherId = "other-user";

function now() {
  return new Date().toISOString();
}

function duplicateError() {
  const error = new Error("duplicate");
  error.code = "23505";
  return error;
}

/**
 * A deliberately small PostgreSQL-shaped test double. It understands the
 * application queries, preserves constraints that matter to the API, and
 * lets the tests exercise HTTP/auth/membership boundaries without requiring a
 * network database.
 */
class MemoryPool {
  constructor() {
    this.rooms = new Map();
    this.members = new Map();
    this.invites = new Map();
    this.entries = new Map();
    this.personal = [];
    this.personalMeta = new Map();
    this.promptPreferences = new Map();
    this.profiles = new Map();
    this.followRequests = new Map();
  }

  memberKey(roomId, uid) {
    return `${roomId}:${uid}`;
  }

  getMember(roomId, uid) {
    return this.members.get(this.memberKey(roomId, uid));
  }

  async query(sql, values = []) {
    const query = sql.replace(/\s+/g, " ").trim();

    if (query === "SELECT 1") return { rows: [{ "?column?": 1 }] };

    if (query.startsWith("SELECT j.id, j.firebase_uid, j.content, j.created_at") && !query.includes("JOIN public_profiles")) {
      const limit = Number.isInteger(values[1]) ? values[1] : 100;
      return {
        rows: this.personal
          .filter((entry) => entry.firebase_uid === values[0])
          .filter((entry) => {
            if (!query.includes("BETWEEN $2 AND $3")) return true;
            const date = this.personalMeta.get(entry.id)?.entry_date || entry.created_at.slice(0, 10);
            return date >= values[1] && date <= values[2];
          })
          .sort((a, b) => {
            const aDate = this.personalMeta.get(a.id)?.entry_date || a.created_at.slice(0, 10);
            const bDate = this.personalMeta.get(b.id)?.entry_date || b.created_at.slice(0, 10);
            return query.includes("ORDER BY entry_date ASC")
              ? `${aDate}${a.created_at}`.localeCompare(`${bDate}${b.created_at}`)
              : `${bDate}${b.created_at}`.localeCompare(`${aDate}${a.created_at}`);
          })
          .slice(0, query.includes("BETWEEN $2 AND $3") ? undefined : limit)
          .map((entry) => ({
            ...entry,
            ...(this.personalMeta.get(entry.id) || {}),
            entry_date: this.personalMeta.get(entry.id)?.entry_date || entry.created_at.slice(0, 10),
            is_public: this.personalMeta.get(entry.id)?.is_public || false,
          })),
      };
    }
    if (query.startsWith("INSERT INTO journal_entries")) {
      const [id, firebase_uid, content] = values;
      const row = { id, firebase_uid, content, created_at: now() };
      this.personal.push(row);
      return { rows: [row] };
    }
    if (query.startsWith("INSERT INTO journal_entry_meta")) {
      if (query.includes("SELECT id, (created_at AT TIME ZONE")) {
        const [entryId, uid, isPublic] = values;
        const entry = this.personal.find((item) => item.id === entryId && item.firebase_uid === uid);
        if (!entry) return { rowCount: 0, rows: [] };
        const current = this.personalMeta.get(entryId) || { entry_id: entryId, entry_date: entry.created_at.slice(0, 10) };
        const updated = { ...current, is_public: isPublic };
        this.personalMeta.set(entryId, updated);
        return { rowCount: 1, rows: [updated] };
      }
      const [entry_id, entry_date, mood_emoji, mood_color, is_public] = values;
      const row = { entry_id, entry_date, mood_emoji, mood_color, is_public };
      this.personalMeta.set(entry_id, row);
      return { rowCount: 1, rows: [row] };
    }
    if (query.startsWith("DELETE FROM journal_entries")) {
      const before = this.personal.length;
      this.personal = this.personal.filter(
        (entry) => !(entry.id === values[0] && entry.firebase_uid === values[1]),
      );
      this.personalMeta.delete(values[0]);
      return { rowCount: before - this.personal.length };
    }

    if (query.startsWith("SELECT categories FROM user_prompt_preferences")) {
      const row = this.promptPreferences.get(values[0]);
      return { rows: row ? [row] : [] };
    }
    if (query.startsWith("SELECT categories, updated_at FROM user_prompt_preferences")) {
      const row = this.promptPreferences.get(values[0]);
      return { rows: row ? [row] : [] };
    }
    if (query.startsWith("INSERT INTO user_prompt_preferences")) {
      const row = { categories: values[1], updated_at: now() };
      this.promptPreferences.set(values[0], row);
      return { rows: [row], rowCount: 1 };
    }

    if (query.startsWith("SELECT firebase_uid, display_name, photo_url, discoverable")) {
      const row = this.profiles.get(values[0]);
      return { rows: row ? [row] : [] };
    }
    if (query.startsWith("INSERT INTO public_profiles")) {
      const row = {
        firebase_uid: values[0],
        display_name: values[1],
        photo_url: values[2],
        discoverable: values[3],
        updated_at: now(),
      };
      this.profiles.set(values[0], row);
      return { rows: [row], rowCount: 1 };
    }
    if (query.startsWith("SELECT firebase_uid FROM public_profiles")) {
      const row = this.profiles.get(values[0]);
      const rows = row?.discoverable ? [{ firebase_uid: values[0] }] : [];
      return { rows, rowCount: rows.length };
    }
    if (query.startsWith("SELECT p.firebase_uid, p.display_name")) {
      const [uid, search] = values;
      const needle = String(search).replace(/^%|%$/g, "").toLowerCase();
      const rows = [...this.profiles.values()]
        .filter((profile) => profile.firebase_uid !== uid && profile.discoverable && profile.display_name.toLowerCase().includes(needle))
        .map((profile) => {
          const follow = [...this.followRequests.values()].find((item) =>
            (item.follower_uid === uid && item.following_uid === profile.firebase_uid) ||
            (item.follower_uid === profile.firebase_uid && item.following_uid === uid),
          );
          return { ...profile, follow_request_id: follow?.id, follow_status: follow?.status };
        });
      return { rows };
    }
    if (query.startsWith("SELECT f.id, f.status, f.created_at")) {
      const incoming = query.includes("f.following_uid = $1");
      const uid = values[0];
      const rows = [...this.followRequests.values()]
        .filter((item) => incoming ? item.following_uid === uid && item.status === "pending" : item.follower_uid === uid)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((item) => {
          const profileUid = incoming ? item.follower_uid : item.following_uid;
          return { ...item, ...this.profiles.get(profileUid) };
        });
      return { rows };
    }
    if (query.startsWith("SELECT id, follower_uid, following_uid, status FROM follow_requests")) {
      const row = [...this.followRequests.values()].find((item) =>
        (item.follower_uid === values[0] && item.following_uid === values[1]) ||
        (item.follower_uid === values[1] && item.following_uid === values[0]),
      );
      return { rows: row ? [row] : [] };
    }
    if (query.startsWith("INSERT INTO follow_requests")) {
      const row = { id: values[0], follower_uid: values[1], following_uid: values[2], status: "pending", created_at: now(), updated_at: now() };
      this.followRequests.set(row.id, row);
      return { rows: [row], rowCount: 1 };
    }
    if (query.startsWith("UPDATE follow_requests")) {
      if (query.includes("WHERE id = $1 AND following_uid = $3")) {
        const row = this.followRequests.get(values[0]);
        if (!row || row.following_uid !== values[2] || row.status !== "pending") return { rows: [], rowCount: 0 };
        row.status = values[1];
        row.updated_at = now();
        return { rows: [row], rowCount: 1 };
      }
      const row = this.followRequests.get(values[0]);
      if (!row) return { rows: [], rowCount: 0 };
      row.status = "pending";
      row.updated_at = now();
      return { rows: [row], rowCount: 1 };
    }
    if (query.startsWith("DELETE FROM follow_requests")) {
      const row = [...this.followRequests.values()].find((item) =>
        (item.status === "accepted" &&
          ((item.follower_uid === values[0] && item.following_uid === values[1]) ||
            (item.follower_uid === values[1] && item.following_uid === values[0]))) ||
        (item.status === "pending" && item.follower_uid === values[0] && item.following_uid === values[1]),
      );
      if (!row) return { rowCount: 0 };
      this.followRequests.delete(row.id);
      return { rowCount: 1 };
    }
    if (query.startsWith("SELECT j.id, j.firebase_uid, j.content, j.created_at")) {
      const [uid, limit] = values;
      const rows = [...this.personal]
        .filter((entry) => this.personalMeta.get(entry.id)?.is_public)
        .filter((entry) => [...this.followRequests.values()].some((follow) =>
          follow.status === "accepted" &&
          ((follow.follower_uid === uid && follow.following_uid === entry.firebase_uid) ||
            (follow.following_uid === uid && follow.follower_uid === entry.firebase_uid))))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit)
        .map((entry) => ({
          ...entry,
          ...this.personalMeta.get(entry.id),
          ...this.profiles.get(entry.firebase_uid),
          entry_date: this.personalMeta.get(entry.id)?.entry_date,
        }));
      return { rows };
    }

    if (query.startsWith("INSERT INTO diary_rooms")) {
      const [id, owner_uid, name] = values;
      this.rooms.set(id, { id, owner_uid, name, created_at: now() });
      return { rowCount: 1 };
    }
    if (query.startsWith("INSERT INTO diary_members")) {
      const roomId = values[0];
      const uid = values[1];
      const owner = query.includes("'owner'");
      const member_slot = owner ? 1 : 2;
      if (!this.rooms.has(roomId) || this.getMember(roomId, uid) || [...this.members.values()].some((member) => member.room_id === roomId && member.member_slot === member_slot)) {
        throw duplicateError();
      }
      const row = { room_id: roomId, firebase_uid: uid, role: owner ? "owner" : "member", member_slot, joined_at: now() };
      this.members.set(this.memberKey(roomId, uid), row);
      return query.includes("RETURNING") ? { rows: [row], rowCount: 1 } : { rowCount: 1 };
    }
    if (query.startsWith("INSERT INTO diary_invites")) {
      const [room_id, token_hash] = values;
      this.invites.set(room_id, { room_id, token_hash, created_at: now(), revoked_at: null });
      return { rowCount: 1 };
    }

    if (query.startsWith("SELECT r.id, r.name, r.owner_uid")) {
      const uid = values[0];
      const rows = [];
      for (const room of this.rooms.values()) {
        const member = this.getMember(room.id, uid);
        if (!member) continue;
        rows.push({
          ...room,
          role: member.role,
          member_count: [...this.members.values()].filter((item) => item.room_id === room.id).length,
        });
      }
      rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { rows };
    }
    if (query.includes("FROM ( SELECT e.*, ROW_NUMBER() OVER")) {
      const roomIds = values[0];
      const rows = [...this.entries.values()]
        .filter((entry) => roomIds.includes(entry.room_id))
        .sort((a, b) => `${b.entry_date}${b.updated_at}`.localeCompare(`${a.entry_date}${a.updated_at}`));
      const result = [];
      for (const roomId of roomIds) {
        result.push(...rows.filter((entry) => entry.room_id === roomId).slice(0, 6));
      }
      return { rows: result };
    }

    if (query.startsWith("SELECT id, name, owner_uid, created_at FROM diary_rooms")) {
      const room = this.rooms.get(values[0]);
      return { rows: room ? [room] : [] };
    }
    if (query.startsWith("SELECT room_id, firebase_uid, role, member_slot, joined_at FROM diary_members")) {
      const member = this.getMember(values[0], values[1]);
      return { rows: member ? [member] : [] };
    }
    if (query.startsWith("SELECT firebase_uid, role, member_slot, joined_at FROM diary_members")) {
      return {
        rows: [...this.members.values()]
          .filter((member) => member.room_id === values[0])
          .sort((a, b) => a.member_slot - b.member_slot),
      };
    }
    if (query.startsWith("SELECT id, room_id, firebase_uid, entry_date, content, created_at, updated_at FROM shared_diary_entries")) {
      const roomId = values[0];
      const limit = values[1] || 365;
      return {
        rows: [...this.entries.values()]
          .filter((entry) => entry.room_id === roomId)
          .sort((a, b) => `${b.entry_date}${b.updated_at}`.localeCompare(`${a.entry_date}${a.updated_at}`))
          .slice(0, limit),
      };
    }

    if (query.startsWith("SELECT room_id, token_hash, created_at, revoked_at FROM diary_invites")) {
      const hash = values.length === 2 ? values[1] : values[0];
      const room = values.length === 2 ? values[0] : null;
      const invite = room ? this.invites.get(room) : [...this.invites.values()].find((item) => item.token_hash === hash);
      return { rows: invite && invite.token_hash === hash ? [invite] : [] };
    }
    if (query.startsWith("SELECT id, name, owner_uid, created_at FROM diary_rooms WHERE id = $1 FOR UPDATE")) {
      const room = this.rooms.get(values[0]);
      return { rows: room ? [room] : [] };
    }
    if (query.startsWith("UPDATE diary_invites")) {
      const invite = this.invites.get(values[0]);
      if (!invite) return { rowCount: 0, rows: [] };
      if (query.includes("token_hash = $2")) {
        invite.token_hash = values[1];
        invite.created_at = now();
        invite.revoked_at = null;
        return { rowCount: 1, rows: [invite] };
      }
      invite.revoked_at ||= now();
      return { rowCount: 1, rows: [] };
    }
    if (query.startsWith("SELECT created_at, revoked_at FROM diary_invites")) {
      const invite = this.invites.get(values[0]);
      return { rows: invite ? [invite] : [] };
    }

    if (query.startsWith("INSERT INTO shared_diary_entries")) {
      const [id, room_id, firebase_uid, entry_date, content] = values;
      const existing = [...this.entries.values()].find(
        (entry) => entry.room_id === room_id && entry.firebase_uid === firebase_uid && entry.entry_date === entry_date,
      );
      if (existing && !query.includes("ON CONFLICT")) throw duplicateError();
      if (existing) {
        existing.content = content;
        existing.updated_at = now();
        return { rows: [existing], rowCount: 1 };
      }
      if (!this.getMember(room_id, firebase_uid)) throw duplicateError();
      const row = { id, room_id, firebase_uid, entry_date, content, created_at: now(), updated_at: now() };
      this.entries.set(id, row);
      return { rows: [row], rowCount: 1 };
    }
    if (query.startsWith("UPDATE shared_diary_entries")) {
      const [roomId, uid, content, reference] = values;
      const entry = [...this.entries.values()].find(
        (item) => item.room_id === roomId && item.firebase_uid === uid &&
          (query.includes("id = $4") ? item.id === reference : item.entry_date === reference),
      );
      if (!entry) return { rows: [], rowCount: 0 };
      entry.content = content;
      entry.updated_at = now();
      return { rows: [entry], rowCount: 1 };
    }
    if (query.startsWith("DELETE FROM shared_diary_entries")) {
      const [roomId, uid, reference] = values;
      const entry = [...this.entries.values()].find(
        (item) => item.room_id === roomId && item.firebase_uid === uid &&
          (query.includes("id = $3") ? item.id === reference : item.entry_date === reference),
      );
      if (!entry) return { rowCount: 0 };
      this.entries.delete(entry.id);
      return { rowCount: 1 };
    }
    if (query.startsWith("DELETE FROM diary_members")) {
      const [roomId, uid] = values;
      const key = this.memberKey(roomId, uid);
      if (!this.members.has(key)) return { rowCount: 0 };
      this.members.delete(key);
      for (const [id, entry] of this.entries) {
        if (entry.room_id === roomId && entry.firebase_uid === uid) this.entries.delete(id);
      }
      return { rowCount: 1 };
    }

    throw new Error(`Unexpected query: ${query}`);
  }
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function start(pool = new MemoryPool()) {
  const tokens = new Map([
    ["owner-token", { uid: ownerId, email: "owner@example.com" }],
    ["friend-token", { uid: friendId, email: "friend@example.com" }],
    ["other-token", { uid: otherId, email: "other@example.com" }],
  ]);
  const app = createApp({
    pool,
    verifyToken: async (token) => {
      const decoded = tokens.get(token);
      if (!decoded) throw new Error("invalid");
      return decoded;
    },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return { pool, server, base: `http://127.0.0.1:${server.address().port}` };
}

async function request(base, token, path, options = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...options.headers,
  };
  return fetch(`${base}${path}`, { ...options, headers });
}

async function json(response) {
  return response.json();
}

test("health endpoint checks database", async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", database: "connected" });
});

test("database migration is safe to run repeatedly", async () => {
  const statements = [];
  const pool = { query: async (sql) => statements.push(sql) };
  await migrate(pool);
  await migrate(pool);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS diary_rooms/);
  assert.match(statements[0], /UNIQUE \(room_id, firebase_uid, entry_date\)/);
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS journal_entry_meta/);
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS follow_requests/);
  assert.equal(statements[0], statements[1]);
});

test("personal entries require a Firebase token and remain owned", async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());
  assert.equal((await fetch(`${base}/api/entries`)).status, 401);
  const created = await request(base, "owner-token", "/api/entries", {
    method: "POST",
    body: JSON.stringify({ content: "내 기록" }),
  });
  assert.equal(created.status, 201);
  const entry = await json(created);
  assert.equal((await request(base, "friend-token", "/api/entries")).status, 200);
  assert.deepEqual((await json(await request(base, "friend-token", "/api/entries"))).entries, []);
  assert.equal((await request(base, "friend-token", `/api/entries/${entry.entry.id}`, { method: "DELETE" })).status, 404);
  assert.equal((await request(base, "owner-token", `/api/entries/${entry.entry.id}`, { method: "DELETE" })).status, 204);
});

test("room creation, member isolation, invite join, and two-member limit", async (t) => {
  const { pool, server, base } = await start();
  t.after(() => server.close());
  const created = await request(base, "owner-token", "/api/rooms", {
    method: "POST",
    body: JSON.stringify({ name: "우리의 하루" }),
  });
  assert.equal(created.status, 201);
  const createdBody = await json(created);
  const roomId = createdBody.room.id;
  const invite = createdBody.invite.token;
  assert.match(invite, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(createdBody.invite.token, invite);
  assert.equal(createdBody.room.member_count, 1);
  assert.equal(pool.invites.get(roomId).token_hash, tokenHash(invite));
  assert.equal(pool.invites.get(roomId).token, undefined);

  const outsiderRoom = await request(base, "other-token", `/api/rooms/${roomId}`);
  assert.equal(outsiderRoom.status, 403);
  assert.deepEqual((await json(await request(base, "other-token", "/api/rooms"))).rooms, []);

  const joined = await request(base, "friend-token", "/api/rooms/join", {
    method: "POST",
    body: JSON.stringify({ invite: `${roomId}.${invite}` }),
  });
  assert.equal(joined.status, 201);
  assert.equal((await json(joined)).room.role, "member");
  assert.equal((await json(await request(base, "owner-token", `/api/rooms/${roomId}`))).room.invite, undefined);

  const full = await request(base, "other-token", "/api/rooms/join", {
    method: "POST",
    body: JSON.stringify({ token: invite, roomId }),
  });
  assert.equal(full.status, 409);
  assert.equal((await json(await request(base, "friend-token", "/api/rooms"))).rooms.length, 1);
});

test("invite regeneration invalidates the old token and revocation denies joining", async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());
  const createdBody = await json(await request(base, "owner-token", "/api/rooms", {
    method: "POST",
    body: JSON.stringify({ name: "초대 테스트" }),
  }));
  const roomId = createdBody.room.id;
  const oldToken = createdBody.invite.token;
  assert.equal((await request(base, "friend-token", `/api/rooms/${roomId}/invite/regenerate`, { method: "POST" })).status, 403);
  const regenerated = await request(base, "owner-token", `/api/rooms/${roomId}/invite/regenerate`, { method: "POST" });
  assert.equal(regenerated.status, 200);
  const newToken = (await json(regenerated)).invite.token;
  assert.notEqual(newToken, oldToken);
  assert.equal((await request(base, "friend-token", "/api/rooms/join", { method: "POST", body: JSON.stringify({ invite: `${roomId}.${oldToken}` }) })).status, 404);
  assert.equal((await request(base, "owner-token", `/api/rooms/${roomId}/invite`, { method: "DELETE" })).status, 204);
  assert.equal((await request(base, "friend-token", "/api/rooms/join", { method: "POST", body: JSON.stringify({ invite: `${roomId}.${newToken}` }) })).status, 404);
  assert.deepEqual((await json(await request(base, "owner-token", `/api/rooms/${roomId}/invite`))).active, false);
  assert.equal(tokenHash(oldToken).length, 64);
});

test("daily uniqueness, own-entry update/delete, member visibility, and validation", async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());
  const createdBody = await json(await request(base, "owner-token", "/api/rooms", { method: "POST", body: JSON.stringify({ name: "기록 테스트" }) }));
  const roomId = createdBody.room.id;
  const invite = createdBody.invite.token;
  await request(base, "friend-token", "/api/rooms/join", { method: "POST", body: JSON.stringify({ invite: `${roomId}.${invite}` }) });
  const date = "2026-09-03";

  const ownerEntryResponse = await request(base, "owner-token", `/api/rooms/${roomId}/entries`, { method: "POST", body: JSON.stringify({ content: "소유자의 한 줄", date }) });
  assert.equal(ownerEntryResponse.status, 201);
  const ownerEntry = (await json(ownerEntryResponse)).entry;
  assert.equal((await request(base, "owner-token", `/api/rooms/${roomId}/entries`, { method: "POST", body: JSON.stringify({ content: "두 번째", date }) })).status, 409);
  const friendEntryResponse = await request(base, "friend-token", `/api/rooms/${roomId}/entries`, { method: "POST", body: JSON.stringify({ content: "친구의 한 줄", date }) });
  assert.equal(friendEntryResponse.status, 201);
  assert.equal((await json(await request(base, "friend-token", `/api/rooms/${roomId}/entries`))).entries.length, 2);
  const roomList = (await json(await request(base, "owner-token", "/api/rooms"))).rooms;
  assert.equal(roomList[0].recent_entries.length, 2);

  const updated = await request(base, "owner-token", `/api/rooms/${roomId}/entries/${ownerEntry.id}`, { method: "PATCH", body: JSON.stringify({ content: "고친 한 줄" }) });
  assert.equal(updated.status, 200);
  assert.equal((await json(updated)).entry.content, "고친 한 줄");
  assert.equal((await request(base, "friend-token", `/api/rooms/${roomId}/entries/${ownerEntry.id}`, { method: "PATCH", body: JSON.stringify({ content: "가로채기" }) })).status, 404);
  assert.equal((await request(base, "friend-token", `/api/rooms/${roomId}/entries/${ownerEntry.id}`, { method: "DELETE" })).status, 404);
  assert.equal((await request(base, "owner-token", `/api/rooms/${roomId}/entries/${ownerEntry.id}`, { method: "DELETE" })).status, 204);

  assert.equal((await request(base, "other-token", `/api/rooms/${roomId}/entries`, { method: "POST", body: JSON.stringify({ content: "몰래 쓰기", date }) })).status, 403);
  assert.equal((await request(base, "owner-token", `/api/rooms/${roomId}/entries`, { method: "POST", body: JSON.stringify({ content: "", date }) })).status, 400);
  assert.equal((await request(base, "owner-token", `/api/rooms/${roomId}/entries`, { method: "POST", body: JSON.stringify({ content: "a".repeat(61), date }) })).status, 400);
  assert.equal((await request(base, "owner-token", `/api/rooms/${roomId}/entries`, { method: "POST", body: JSON.stringify({ content: "날짜 오류", date: "2026-02-30" }) })).status, 400);
  assert.equal((await request(base, "owner-token", `/api/rooms/${roomId}/entries/not-an-entry`, { method: "DELETE" })).status, 400);
});

test("member can leave and releases the second room slot", async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());
  const createdBody = await json(await request(base, "owner-token", "/api/rooms", { method: "POST", body: JSON.stringify({ name: "나가기 테스트" }) }));
  const roomId = createdBody.room.id;
  const invite = createdBody.invite.token;
  await request(base, "friend-token", "/api/rooms/join", { method: "POST", body: JSON.stringify({ invite: `${roomId}.${invite}` }) });
  assert.equal((await request(base, "friend-token", `/api/rooms/${roomId}/members/me`, { method: "DELETE" })).status, 204);
  assert.equal((await request(base, "friend-token", `/api/rooms/${roomId}`)).status, 403);
  assert.equal((await json(await request(base, "owner-token", `/api/rooms/${roomId}`))).room.member_count, 1);
  assert.equal((await request(base, "other-token", "/api/rooms/join", { method: "POST", body: JSON.stringify({ invite: `${roomId}.${invite}` }) })).status, 201);
});

test("line breaks survive a round trip and are normalised", async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());

  // CRLF collapses to LF so the same text typed on Windows and macOS is
  // stored identically.
  const created = await json(
    await request(base, "owner-token", "/api/entries", {
      method: "POST",
      body: JSON.stringify({ content: "첫 줄\u000d\n둘째 줄" }),
    }),
  );
  assert.equal(created.entry.content, "첫 줄\n둘째 줄");

  // Leading/trailing blank lines are trimmed and long runs collapse to one
  // blank line, but interior breaks are preserved.
  const padded = await json(
    await request(base, "owner-token", "/api/entries", {
      method: "POST",
      body: JSON.stringify({ content: "\n\n위\n\n\n\n아래\n\n" }),
    }),
  );
  assert.equal(padded.entry.content, "위\n\n아래");

  // Other control characters are stripped rather than stored.
  const controls = await json(
    await request(base, "owner-token", "/api/entries", {
      method: "POST",
      body: JSON.stringify({ content: "탭\t문자\u0000" }),
    }),
  );
  assert.equal(controls.entry.content, "탭문자");

  // A newline counts toward the 60 character budget.
  const tooLong = await request(base, "owner-token", "/api/entries", {
    method: "POST",
    body: JSON.stringify({ content: `${"가".repeat(60)}\n나` }),
  });
  assert.equal(tooLong.status, 400);

  // Whitespace-only content is still rejected.
  assert.equal(
    (await request(base, "owner-token", "/api/entries", {
      method: "POST",
      body: JSON.stringify({ content: "\n\n   \n" }),
    })).status,
    400,
  );

  // Shared entries go through the same validator.
  const room = await json(
    await request(base, "owner-token", "/api/rooms", {
      method: "POST",
      body: JSON.stringify({ name: "줄바꿈 방" }),
    }),
  );
  const shared = await json(
    await request(base, "owner-token", `/api/rooms/${room.room.id}/entries`, {
      method: "POST",
      body: JSON.stringify({ content: "공유\u000d\n줄바꿈", date: "2026-09-04" }),
    }),
  );
  assert.equal(shared.entry.content, "공유\n줄바꿈");
});

test("personal entry limit is caller controlled and clamped", async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());

  for (let index = 0; index < 12; index += 1) {
    await request(base, "owner-token", "/api/entries", {
      method: "POST",
      body: JSON.stringify({ content: `기록 ${index}` }),
    });
  }

  const limited = await json(
    await request(base, "owner-token", "/api/entries?limit=5"),
  );
  assert.equal(limited.entries.length, 5);

  // The default stays at 100 and the archive can ask for a wider window.
  const wide = await json(
    await request(base, "owner-token", "/api/entries?limit=1000"),
  );
  assert.equal(wide.entries.length, 12);

  // Junk and out-of-range values fall back instead of failing.
  for (const query of ["", "?limit=abc", "?limit=0", "?limit=-3", "?limit=1.5"]) {
    const response = await request(base, "owner-token", `/api/entries${query}`);
    assert.equal(response.status, 200);
    assert.equal((await json(response)).entries.length, 12);
  }

  // Still scoped to the caller.
  assert.deepEqual(
    (await json(await request(base, "friend-token", "/api/entries?limit=1000"))).entries,
    [],
  );
});

test("personal entries keep mood metadata, calendar dates, and visibility ownership", async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());

  const created = await request(base, "owner-token", "/api/entries", {
    method: "POST",
    body: JSON.stringify({
      content: "오늘의 기분",
      entry_date: "2026-09-01",
      mood_emoji: "😊",
      mood_color: "sage",
      is_public: true,
    }),
  });
  assert.equal(created.status, 201);
  const entry = (await json(created)).entry;
  assert.equal(entry.entry_date, "2026-09-01");
  assert.equal(entry.mood_emoji, "😊");
  assert.equal(entry.mood_color, "sage");
  assert.equal(entry.is_public, true);

  const calendar = await json(
    await request(base, "owner-token", "/api/entries/calendar?from=2026-09-01&to=2026-09-30"),
  );
  assert.equal(calendar.entries.length, 1);
  assert.equal(calendar.entries[0].entry_date, "2026-09-01");
  assert.equal(
    (await request(base, "friend-token", "/api/entries/" + entry.id + "/visibility", {
      method: "PATCH",
      body: JSON.stringify({ is_public: false }),
    })).status,
    404,
  );
  assert.equal(
    (await request(base, "owner-token", "/api/entries", {
      method: "POST",
      body: JSON.stringify({ content: "잘못된 기분", mood_emoji: "😈" }),
    })).status,
    400,
  );
});

test("daily prompts and prompt preferences are authenticated", async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());

  const prompt = await json(await request(base, "owner-token", "/api/prompts/today?date=2026-09-04"));
  assert.equal(prompt.date, "2026-09-04");
  assert.ok(prompt.prompt.id);
  assert.ok(prompt.prompt.text);

  const saved = await json(
    await request(base, "owner-token", "/api/me/prompt-preferences", {
      method: "PUT",
      body: JSON.stringify({ categories: ["감정"] }),
    }),
  );
  assert.deepEqual(saved.categories, ["감정"]);
  const filtered = await json(await request(base, "owner-token", "/api/prompts/today?date=2026-09-04"));
  assert.equal(filtered.prompt.category, "감정");
  assert.equal(
    (await request(base, "owner-token", "/api/me/prompt-preferences", {
      method: "PUT",
      body: JSON.stringify({ categories: ["없는 주제"] }),
    })).status,
    400,
  );

  const room = await json(await request(base, "owner-token", "/api/rooms", {
    method: "POST",
    body: JSON.stringify({ name: "주제 방" }),
  }));
  assert.equal(
    (await request(base, "owner-token", "/api/diaries/" + room.room.id + "/prompt?date=2026-09-04")).status,
    200,
  );
  assert.equal(
    (await request(base, "friend-token", "/api/rooms/" + room.room.id + "/prompt?date=2026-09-04")).status,
    403,
  );
});

test("approved friends can see only explicitly public personal entries", async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());

  for (const [token, name] of [["owner-token", "오너"], ["friend-token", "친구"], ["other-token", "다른 사람"]]) {
    assert.equal(
      (await request(base, token, "/api/me/profile", {
        method: "PUT",
        body: JSON.stringify({ display_name: name, discoverable: true }),
      })).status,
      200,
    );
  }

  const search = await json(await request(base, "owner-token", "/api/users/search?q=친구"));
  assert.equal(search.users.length, 1);
  const follow = await json(
    await request(base, "owner-token", "/api/users/" + search.users[0].uid + "/follow", { method: "POST" }),
  );
  assert.equal(follow.follow_request.status, "pending");

  const incoming = await json(await request(base, "friend-token", "/api/me/follow-requests"));
  assert.equal(incoming.incoming.length, 1);
  assert.equal(
    (await request(base, "friend-token", "/api/follow-requests/" + incoming.incoming[0].id + "/accept", {
      method: "POST",
    })).status,
    200,
  );

  const publicEntry = await json(
    await request(base, "owner-token", "/api/entries", {
      method: "POST",
      body: JSON.stringify({ content: "친구에게 공개", is_public: true }),
    }),
  );
  await request(base, "owner-token", "/api/entries", {
    method: "POST",
    body: JSON.stringify({ content: "나만 볼 기록", is_public: false }),
  });

  const feed = await json(await request(base, "friend-token", "/api/feed"));
  assert.equal(feed.entries.length, 1);
  assert.equal(feed.entries[0].id, publicEntry.entry.id);
  assert.equal(feed.entries[0].author.display_name, "오너");
  assert.deepEqual((await json(await request(base, "other-token", "/api/feed"))).entries, []);
});
