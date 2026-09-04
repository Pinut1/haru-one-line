import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { createAuthMiddleware } from "./auth.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;

class HttpError extends Error {
  constructor(status, message, code = "request_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function allowedOrigin(origin) {
  if (!origin) return true;

  const configured = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (configured.includes(origin)) return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return true;
  }
  return /^https:\/\/haru-one-line(?:-[a-z0-9-]+)?\.vercel\.app$/.test(origin);
}

function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function characterLength(value) {
  return Array.from(value).length;
}

function validDate(value) {
  if (typeof value !== "string") return false;
  const match = value.match(DATE_PATTERN);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function readContent(value) {
  if (typeof value !== "string") {
    throw new HttpError(400, "기록은 1~60자로 입력해 주세요.", "invalid_content");
  }

  // Line breaks are part of the record. Normalise CRLF/CR to LF so the same
  // text typed on Windows and macOS is stored identically, and drop other
  // control characters that would only corrupt rendering.
  const content = value
    .replace(/\u000d\u000a?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "")
    .trim();

  if (!content || characterLength(content) > 60) {
    throw new HttpError(400, "기록은 1~60자로 입력해 주세요.", "invalid_content");
  }
  return content;
}

function readLimit(value, fallback, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function readDate(body = {}) {
  body = body && typeof body === "object" ? body : {};
  const value = body.date ?? body.entry_date ?? body.entryDate ?? todayUtc();
  if (!validDate(value)) {
    throw new HttpError(
      400,
      "날짜는 YYYY-MM-DD 형식의 유효한 날짜여야 합니다.",
      "invalid_date",
    );
  }
  return value;
}

function readRoomId(value) {
  if (!isUuid(value)) {
    throw new HttpError(400, "올바르지 않은 다이어리 ID입니다.", "invalid_room_id");
  }
  return value;
}

function readEntryRef(value) {
  if (isUuid(value) || validDate(value)) return value;
  throw new HttpError(400, "올바르지 않은 기록 ID 또는 날짜입니다.", "invalid_entry_ref");
}

function makeInviteToken() {
  // 256 bits of entropy; only the SHA-256 digest is persisted.
  return crypto.randomBytes(32).toString("base64url");
}

function hashInviteToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function roomJson(row, extra = {}) {
  return {
    id: row.id,
    name: row.name,
    owner_uid: row.owner_uid,
    created_at: row.created_at,
    role: row.role,
    member_count:
      row.member_count === undefined ? undefined : Number(row.member_count),
    ...extra,
  };
}

function entryJson(row) {
  return {
    id: row.id,
    room_id: row.room_id,
    firebase_uid: row.firebase_uid,
    member_uid: row.firebase_uid,
    entry_date: row.entry_date,
    date: row.entry_date,
    content: row.content,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function withTransaction(pool, callback) {
  // A small fallback keeps createApp easy to exercise with a query-only test
  // double. Production uses pg's dedicated client and real transactions.
  if (typeof pool.connect !== "function") return callback(pool);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original database error.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function findMembership(db, roomId, uid, lock = false) {
  const suffix = lock ? " FOR UPDATE" : "";
  const result = await db.query(
    `SELECT room_id, firebase_uid, role, member_slot, joined_at
       FROM diary_members
      WHERE room_id = $1 AND firebase_uid = $2${suffix}`,
    [roomId, uid],
  );
  return result.rows[0] || null;
}

async function requireMembership(db, roomId, uid) {
  const membership = await findMembership(db, roomId, uid);
  if (!membership) {
    throw new HttpError(403, "이 다이어리의 멤버만 볼 수 있습니다.", "not_a_member");
  }
  return membership;
}

async function requireOwner(db, roomId, uid) {
  const membership = await findMembership(db, roomId, uid);
  if (!membership || membership.role !== "owner") {
    throw new HttpError(403, "다이어리 소유자만 초대를 관리할 수 있습니다.", "owner_only");
  }
  return membership;
}

function inviteInput(body = {}, pathRoomId = null) {
  body = body && typeof body === "object" ? body : {};
  let raw =
    body.invite ??
    body.inviteToken ??
    body.inviteCode ??
    body.inviteLink ??
    body.invite_link ??
    body.token;
  let roomId = body.roomId ?? body.room_id ?? pathRoomId;

  if (typeof raw !== "string") {
    throw new HttpError(400, "초대 링크 또는 초대 토큰을 입력해 주세요.", "invalid_invite");
  }
  raw = raw.trim();

  // Accept a copied full URL as well as the compact `roomId.token` value.
  try {
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw);
      raw = url.searchParams.get("invite") || raw;
    }
  } catch {
    throw new HttpError(400, "초대 링크가 올바르지 않습니다.", "invalid_invite");
  }

  if (raw.includes(".")) {
    const [candidateRoomId, candidateToken, ...extra] = raw.split(".");
    if (!extra.length) {
      roomId = roomId || candidateRoomId;
      raw = candidateToken;
    }
  }

  if (roomId !== null && roomId !== undefined) roomId = readRoomId(roomId);
  if (!INVITE_TOKEN_PATTERN.test(raw)) {
    throw new HttpError(400, "초대 토큰이 올바르지 않습니다.", "invalid_invite");
  }
  return { roomId, token: raw };
}

function entryWhere(reference, firstParam) {
  if (isUuid(reference)) return [`id = $${firstParam}`, reference];
  return [`entry_date = $${firstParam}`, reference];
}

export function createApp({ pool, verifyToken }) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        callback(null, allowedOrigin(origin));
      },
    }),
  );
  app.use(express.json({ limit: "10kb" }));
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  // Shared records should reflect the latest write for either member and
  // invite-bearing responses must never be cached by an intermediary.
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.get("/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok", database: "connected" });
    } catch {
      res.status(503).json({ status: "error", database: "disconnected" });
    }
  });

  const requireAuth = createAuthMiddleware(verifyToken);

  // Existing personal diary API. It deliberately remains separate from
  // shared rooms so a personal entry can never be exposed through a room.
  app.get("/api/entries", requireAuth, async (req, res, next) => {
    try {
      // The archive groups entries by day on the client, so the list has to be
      // able to reach past the newest 100 records. The uid condition stays.
      const limit = readLimit(req.query.limit, 100, 1000);
      const result = await pool.query(
        "SELECT id, content, created_at FROM journal_entries WHERE firebase_uid = $1 ORDER BY created_at DESC LIMIT $2",
        [req.user.uid, limit],
      );
      res.json({ entries: result.rows });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/entries", requireAuth, async (req, res, next) => {
    try {
      const content = readContent(req.body?.content);
      const result = await pool.query(
        "INSERT INTO journal_entries (id, firebase_uid, content) VALUES ($1, $2, $3) RETURNING id, content, created_at",
        [crypto.randomUUID(), req.user.uid, content],
      );
      res.status(201).json({ entry: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/entries/:id", requireAuth, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) {
        throw new HttpError(400, "올바르지 않은 기록 ID입니다.", "invalid_entry_id");
      }

      const result = await pool.query(
        "DELETE FROM journal_entries WHERE id = $1 AND firebase_uid = $2",
        [req.params.id, req.user.uid],
      );
      if (!result.rowCount) {
        throw new HttpError(404, "기록을 찾을 수 없습니다.", "entry_not_found");
      }
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  async function listRooms(req, res, next) {
    try {
      const roomsResult = await pool.query(
        `SELECT r.id, r.name, r.owner_uid, r.created_at, m.role,
                (SELECT COUNT(*) FROM diary_members dm WHERE dm.room_id = r.id) AS member_count
           FROM diary_rooms r
           JOIN diary_members m ON m.room_id = r.id
          WHERE m.firebase_uid = $1
          ORDER BY r.created_at DESC`,
        [req.user.uid],
      );
      const rooms = roomsResult.rows.map((row) => roomJson(row, { recent_entries: [] }));

      if (rooms.length) {
        const recentResult = await pool.query(
          `SELECT id, room_id, firebase_uid, entry_date, content, created_at, updated_at
             FROM (
               SELECT e.*, ROW_NUMBER() OVER (
                 PARTITION BY e.room_id
                 ORDER BY e.entry_date DESC, e.updated_at DESC
               ) AS row_number
                 FROM shared_diary_entries e
                WHERE e.room_id = ANY($1::uuid[])
             ) recent
            WHERE row_number <= 6
            ORDER BY entry_date DESC, updated_at DESC`,
          [rooms.map((room) => room.id)],
        );
        const byRoom = new Map(rooms.map((room) => [room.id, []]));
        for (const row of recentResult.rows) {
          byRoom.get(row.room_id)?.push(entryJson(row));
        }
        for (const room of rooms) room.recent_entries = byRoom.get(room.id) || [];
      }

      res.json({ rooms });
    } catch (error) {
      next(error);
    }
  }

  app.get(["/api/rooms", "/api/diaries"], requireAuth, listRooms);

  async function createRoom(req, res, next) {
    try {
      const nameValue = req.body?.name ?? req.body?.title ?? "우리의 하루";
      if (typeof nameValue !== "string") {
        throw new HttpError(400, "다이어리 이름을 입력해 주세요.", "invalid_room_name");
      }
      const name = nameValue.trim() || "우리의 하루";
      if (characterLength(name) > 120) {
        throw new HttpError(400, "다이어리 이름은 120자 이내여야 합니다.", "invalid_room_name");
      }

      const roomId = crypto.randomUUID();
      const token = makeInviteToken();
      const tokenHash = hashInviteToken(token);

      await withTransaction(pool, async (db) => {
        await db.query(
          "INSERT INTO diary_rooms (id, owner_uid, name) VALUES ($1, $2, $3)",
          [roomId, req.user.uid, name],
        );
        await db.query(
          `INSERT INTO diary_members
             (room_id, firebase_uid, role, member_slot)
           VALUES ($1, $2, 'owner', 1)`,
          [roomId, req.user.uid],
        );
        await db.query(
          "INSERT INTO diary_invites (room_id, token_hash) VALUES ($1, $2)",
          [roomId, tokenHash],
        );
      });

      res.set("Cache-Control", "no-store");
      res.status(201).json({
        room: {
          id: roomId,
          name,
          owner_uid: req.user.uid,
          role: "owner",
          member_count: 1,
          created_at: new Date().toISOString(),
        },
        // The raw token is returned only at creation/regeneration time. It is
        // never read back from the database or included in room list/detail.
        invite: { token, inviteToken: token },
      });
    } catch (error) {
      next(error);
    }
  }

  app.post(["/api/rooms", "/api/diaries"], requireAuth, createRoom);

  async function getRoom(req, res, next) {
    try {
      const roomId = readRoomId(req.params.roomId);
      // Check membership before reading any room metadata or entries.
      const membership = await requireMembership(pool, roomId, req.user.uid);
      const roomResult = await pool.query(
        "SELECT id, name, owner_uid, created_at FROM diary_rooms WHERE id = $1",
        [roomId],
      );
      if (!roomResult.rows[0]) {
        throw new HttpError(404, "다이어리를 찾을 수 없습니다.", "room_not_found");
      }

      const [membersResult, entriesResult] = await Promise.all([
        pool.query(
          `SELECT firebase_uid, role, member_slot, joined_at
             FROM diary_members
            WHERE room_id = $1
            ORDER BY member_slot`,
          [roomId],
        ),
        pool.query(
          `SELECT id, room_id, firebase_uid, entry_date, content, created_at, updated_at
             FROM shared_diary_entries
            WHERE room_id = $1
            ORDER BY entry_date DESC, updated_at DESC
            LIMIT 365`,
          [roomId],
        ),
      ]);

      const row = roomResult.rows[0];
      const room = roomJson(
        { ...row, role: membership.role, member_count: membersResult.rows.length },
        { recent_entries: entriesResult.rows.slice(0, 6).map(entryJson) },
      );
      res.json({
        room,
        members: membersResult.rows.map((member) => ({
          uid: member.firebase_uid,
          firebase_uid: member.firebase_uid,
          role: member.role,
          member_slot: member.member_slot,
          joined_at: member.joined_at,
        })),
        entries: entriesResult.rows.map(entryJson),
      });
    } catch (error) {
      next(error);
    }
  }

  app.get("/api/rooms/:roomId", requireAuth, getRoom);
  app.get("/api/diaries/:roomId", requireAuth, getRoom);

  async function joinRoom(req, res, next) {
    try {
      const { roomId, token } = inviteInput(req.body, req.params.roomId || null);
      const tokenHash = hashInviteToken(token);

      const result = await withTransaction(pool, async (db) => {
        const inviteResult = roomId
          ? await db.query(
              `SELECT room_id, token_hash, created_at, revoked_at
                 FROM diary_invites
                WHERE room_id = $1 AND token_hash = $2
                FOR UPDATE`,
              [roomId, tokenHash],
            )
          : await db.query(
              `SELECT room_id, token_hash, created_at, revoked_at
                 FROM diary_invites
                WHERE token_hash = $1
                FOR UPDATE`,
              [tokenHash],
            );

        const invite = inviteResult.rows[0];
        if (!invite || invite.revoked_at) {
          throw new HttpError(404, "초대 링크가 만료되었거나 취소되었습니다.", "invite_invalid");
        }

        const resolvedRoomId = invite.room_id;
        const roomResult = await db.query(
          "SELECT id, name, owner_uid, created_at FROM diary_rooms WHERE id = $1 FOR UPDATE",
          [resolvedRoomId],
        );
        const room = roomResult.rows[0];
        if (!room) {
          throw new HttpError(404, "다이어리를 찾을 수 없습니다.", "room_not_found");
        }
        if (room.owner_uid === req.user.uid) {
          throw new HttpError(409, "다이어리 소유자는 자신의 초대로 참여할 수 없습니다.", "owner_cannot_join");
        }

        const existing = await findMembership(db, resolvedRoomId, req.user.uid, true);
        if (existing) {
          return { room, membership: existing, joined: false };
        }

        // member_slot=2 plus the UNIQUE(room_id, member_slot) constraint is
        // the final race-safe two-member limit.
        let membership;
        try {
          const memberResult = await db.query(
            `INSERT INTO diary_members
               (room_id, firebase_uid, role, member_slot)
             VALUES ($1, $2, 'member', 2)
             RETURNING room_id, firebase_uid, role, member_slot, joined_at`,
            [resolvedRoomId, req.user.uid],
          );
          membership = memberResult.rows[0];
        } catch (error) {
          if (error.code === "23505") {
            throw new HttpError(409, "이 다이어리는 이미 두 명이 함께 쓰고 있습니다.", "room_full");
          }
          throw error;
        }
        return { room, membership, joined: true };
      });

      const status = result.joined ? 201 : 200;
      res.status(status).json({
        room: {
          id: result.room.id,
          name: result.room.name,
          owner_uid: result.room.owner_uid,
          role: result.membership.role,
          member_count: 2,
          created_at: result.room.created_at,
        },
        membership: {
          role: result.membership.role,
          member_slot: result.membership.member_slot,
          joined_at: result.membership.joined_at,
        },
        joined: result.joined,
      });
    } catch (error) {
      next(error);
    }
  }

  app.post("/api/rooms/join", requireAuth, joinRoom);
  app.post("/api/diaries/join", requireAuth, joinRoom);
  app.post("/api/rooms/:roomId/join", requireAuth, joinRoom);
  app.post("/api/diaries/:roomId/join", requireAuth, joinRoom);

  async function regenerateInvite(req, res, next) {
    try {
      const roomId = readRoomId(req.params.roomId);
      await requireOwner(pool, roomId, req.user.uid);
      const token = makeInviteToken();
      const result = await pool.query(
        `UPDATE diary_invites
            SET token_hash = $2, created_at = NOW(), revoked_at = NULL
          WHERE room_id = $1
        RETURNING created_at, revoked_at`,
        [roomId, hashInviteToken(token)],
      );
      if (!result.rowCount) {
        throw new HttpError(404, "초대 정보를 찾을 수 없습니다.", "invite_not_found");
      }
      res.set("Cache-Control", "no-store");
      res.json({ invite: { token, inviteToken: token }, created_at: result.rows[0].created_at });
    } catch (error) {
      next(error);
    }
  }

  app.post("/api/rooms/:roomId/invite", requireAuth, regenerateInvite);
  app.post("/api/rooms/:roomId/invite/regenerate", requireAuth, regenerateInvite);
  app.put("/api/rooms/:roomId/invite", requireAuth, regenerateInvite);
  app.post("/api/diaries/:roomId/invite", requireAuth, regenerateInvite);

  async function revokeInvite(req, res, next) {
    try {
      const roomId = readRoomId(req.params.roomId);
      await requireOwner(pool, roomId, req.user.uid);
      const result = await pool.query(
        `UPDATE diary_invites
            SET revoked_at = COALESCE(revoked_at, NOW())
          WHERE room_id = $1`,
        [roomId],
      );
      if (!result.rowCount) {
        throw new HttpError(404, "초대 정보를 찾을 수 없습니다.", "invite_not_found");
      }
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  }

  app.delete("/api/rooms/:roomId/invite", requireAuth, revokeInvite);
  app.post("/api/rooms/:roomId/invite/revoke", requireAuth, revokeInvite);
  app.delete("/api/diaries/:roomId/invite", requireAuth, revokeInvite);

  async function inviteStatus(req, res, next) {
    try {
      const roomId = readRoomId(req.params.roomId);
      await requireOwner(pool, roomId, req.user.uid);
      const result = await pool.query(
        "SELECT created_at, revoked_at FROM diary_invites WHERE room_id = $1",
        [roomId],
      );
      if (!result.rows[0]) {
        throw new HttpError(404, "초대 정보를 찾을 수 없습니다.", "invite_not_found");
      }
      res.json({
        active: !result.rows[0].revoked_at,
        created_at: result.rows[0].created_at,
        revoked_at: result.rows[0].revoked_at,
      });
    } catch (error) {
      next(error);
    }
  }

  app.get("/api/rooms/:roomId/invite", requireAuth, inviteStatus);

  async function listRoomEntries(req, res, next) {
    try {
      const roomId = readRoomId(req.params.roomId);
      await requireMembership(pool, roomId, req.user.uid);
      const limit = readLimit(req.query.limit, 365, 365);
      const result = await pool.query(
        `SELECT id, room_id, firebase_uid, entry_date, content, created_at, updated_at
           FROM shared_diary_entries
          WHERE room_id = $1
          ORDER BY entry_date DESC, updated_at DESC
          LIMIT $2`,
        [roomId, limit],
      );
      res.json({ entries: result.rows.map(entryJson) });
    } catch (error) {
      next(error);
    }
  }

  app.get("/api/rooms/:roomId/entries", requireAuth, listRoomEntries);
  app.get("/api/rooms/:roomId/history", requireAuth, listRoomEntries);
  app.get("/api/diaries/:roomId/entries", requireAuth, listRoomEntries);

  async function createRoomEntry(req, res, next) {
    try {
      const roomId = readRoomId(req.params.roomId);
      await requireMembership(pool, roomId, req.user.uid);
      const content = readContent(req.body?.content);
      const entryDate = readDate(req.body);
      const result = await pool.query(
        `INSERT INTO shared_diary_entries
           (id, room_id, firebase_uid, entry_date, content)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, room_id, firebase_uid, entry_date, content, created_at, updated_at`,
        [crypto.randomUUID(), roomId, req.user.uid, entryDate, content],
      );
      res.status(201).json({ entry: entryJson(result.rows[0]) });
    } catch (error) {
      next(error);
    }
  }

  app.post("/api/rooms/:roomId/entries", requireAuth, createRoomEntry);
  app.post("/api/diaries/:roomId/entries", requireAuth, createRoomEntry);

  async function upsertRoomEntry(req, res, next) {
    try {
      const roomId = readRoomId(req.params.roomId);
      await requireMembership(pool, roomId, req.user.uid);
      const content = readContent(req.body?.content);
      const entryDate = readDate(req.body);
      const result = await pool.query(
        `INSERT INTO shared_diary_entries
           (id, room_id, firebase_uid, entry_date, content)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (room_id, firebase_uid, entry_date)
         DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()
         RETURNING id, room_id, firebase_uid, entry_date, content, created_at, updated_at`,
        [crypto.randomUUID(), roomId, req.user.uid, entryDate, content],
      );
      res.json({ entry: entryJson(result.rows[0]) });
    } catch (error) {
      next(error);
    }
  }

  app.put("/api/rooms/:roomId/entries", requireAuth, upsertRoomEntry);
  app.put("/api/diaries/:roomId/entries", requireAuth, upsertRoomEntry);

  async function updateRoomEntry(req, res, next) {
    try {
      const roomId = readRoomId(req.params.roomId);
      await requireMembership(pool, roomId, req.user.uid);
      const reference = readEntryRef(req.params.entryRef);
      const content = readContent(req.body?.content);
      const [condition, referenceValue] = entryWhere(reference, 4);
      const result = await pool.query(
        `UPDATE shared_diary_entries
            SET content = $3, updated_at = NOW()
          WHERE room_id = $1 AND firebase_uid = $2 AND ${condition}
        RETURNING id, room_id, firebase_uid, entry_date, content, created_at, updated_at`,
        [roomId, req.user.uid, content, referenceValue],
      );
      if (!result.rowCount) {
        throw new HttpError(404, "수정할 기록을 찾을 수 없습니다.", "entry_not_found");
      }
      res.json({ entry: entryJson(result.rows[0]) });
    } catch (error) {
      next(error);
    }
  }

  app.patch("/api/rooms/:roomId/entries/:entryRef", requireAuth, updateRoomEntry);
  app.put("/api/rooms/:roomId/entries/:entryRef", requireAuth, updateRoomEntry);
  app.patch("/api/diaries/:roomId/entries/:entryRef", requireAuth, updateRoomEntry);

  async function deleteRoomEntry(req, res, next) {
    try {
      const roomId = readRoomId(req.params.roomId);
      await requireMembership(pool, roomId, req.user.uid);
      const reference = readEntryRef(req.params.entryRef);
      const [condition, referenceValue] = entryWhere(reference, 3);
      const result = await pool.query(
        `DELETE FROM shared_diary_entries
          WHERE room_id = $1 AND firebase_uid = $2 AND ${condition}`,
        [roomId, req.user.uid, referenceValue],
      );
      if (!result.rowCount) {
        throw new HttpError(404, "삭제할 기록을 찾을 수 없습니다.", "entry_not_found");
      }
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  }

  app.delete("/api/rooms/:roomId/entries/:entryRef", requireAuth, deleteRoomEntry);
  app.delete("/api/diaries/:roomId/entries/:entryRef", requireAuth, deleteRoomEntry);

  async function leaveRoom(req, res, next) {
    try {
      const roomId = readRoomId(req.params.roomId);
      const membership = await requireMembership(pool, roomId, req.user.uid);
      if (membership.role === "owner") {
        throw new HttpError(
          400,
          "소유자는 다이어리를 나갈 수 없습니다. 먼저 친구가 나가도록 해 주세요.",
          "owner_cannot_leave",
        );
      }
      const result = await pool.query(
        "DELETE FROM diary_members WHERE room_id = $1 AND firebase_uid = $2",
        [roomId, req.user.uid],
      );
      if (!result.rowCount) {
        throw new HttpError(404, "멤버 정보를 찾을 수 없습니다.", "member_not_found");
      }
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  }

  app.delete("/api/rooms/:roomId/members/me", requireAuth, leaveRoom);
  app.delete("/api/rooms/:roomId/leave", requireAuth, leaveRoom);
  app.post("/api/rooms/:roomId/leave", requireAuth, leaveRoom);
  app.delete("/api/diaries/:roomId/members/me", requireAuth, leaveRoom);

  app.use((error, _req, res, _next) => {
    if (error instanceof HttpError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    if (error?.type === "entity.parse.failed") {
      return res.status(400).json({ error: "요청 본문이 올바른 JSON이 아닙니다.", code: "invalid_json" });
    }
    if (error?.code === "23505") {
      return res.status(409).json({
        error: "같은 날짜에는 멤버별로 한 줄만 기록할 수 있습니다.",
        code: "daily_entry_exists",
      });
    }
    if (error?.code === "23503") {
      return res.status(403).json({
        error: "이 다이어리의 멤버만 기록할 수 있습니다.",
        code: "not_a_member",
      });
    }
    if (error?.code === "23514") {
      return res.status(400).json({ error: "입력값이 유효하지 않습니다.", code: "constraint_violation" });
    }
    console.error(error);
    res.status(500).json({ error: "서버에서 문제가 발생했습니다.", code: "server_error" });
  });

  return app;
}
