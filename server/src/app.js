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
const USER_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
const MOOD_EMOJIS = new Set(["😊", "😌", "🥰", "😐", "😔", "😤", "😴", "🤩"]);
const MOOD_COLORS = new Set(["sage", "blue", "yellow", "orange", "rose", "lavender"]);
const PROMPTS = [
  { id: "small-win", category: "일상", text: "오늘 작지만 잘 해낸 일은 무엇인가요?" },
  { id: "good-moment", category: "일상", text: "오늘 가장 마음이 편안했던 순간은 언제였나요?" },
  { id: "new-discovery", category: "일상", text: "오늘 새롭게 발견한 것은 무엇인가요?" },
  { id: "thankful", category: "감정", text: "오늘 고마웠던 사람이나 일은 무엇인가요?" },
  { id: "feeling-color", category: "감정", text: "오늘의 기분을 색으로 표현하면 어떤 색인가요?" },
  { id: "energy", category: "감정", text: "오늘 나의 에너지는 어디에 가장 많이 쓰였나요?" },
  { id: "memory", category: "추억", text: "문득 떠오른 오래된 기억이 있나요?" },
  { id: "childhood", category: "추억", text: "어릴 때 좋아했던 것을 하나 떠올려 보세요." },
  { id: "future-self", category: "미래", text: "한 달 뒤의 나에게 한마디를 남긴다면?" },
  { id: "wish", category: "미래", text: "이번 주에 꼭 해보고 싶은 작은 일은 무엇인가요?" },
  { id: "question", category: "서로에게", text: "친구에게 오늘 꼭 묻고 싶은 것은 무엇인가요?" },
  { id: "together", category: "서로에게", text: "우리 둘이 함께 해보고 싶은 일은 무엇인가요?" },
];
const PROMPT_CATEGORIES = [...new Set(PROMPTS.map((prompt) => prompt.category))];

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

function readUserId(value) {
  if (typeof value !== "string" || !USER_ID_PATTERN.test(value)) {
    throw new HttpError(400, "사용자 ID가 올바르지 않습니다.", "invalid_user_id");
  }
  return value;
}

function readBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new HttpError(400, "공개 여부가 올바르지 않습니다.", "invalid_visibility");
}

function readMoodEmoji(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !MOOD_EMOJIS.has(value)) {
    throw new HttpError(400, "기분 이모지를 다시 골라 주세요.", "invalid_mood");
  }
  return value;
}

function readMoodColor(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !MOOD_COLORS.has(value)) {
    throw new HttpError(400, "기분 색상을 다시 골라 주세요.", "invalid_mood");
  }
  return value;
}

function readDisplayName(value, fallback = "하루 기록자") {
  const name = typeof value === "string" ? value.trim() : fallback;
  if (!name || characterLength(name) > 40) {
    throw new HttpError(400, "닉네임은 1~40자로 입력해 주세요.", "invalid_profile");
  }
  return name;
}

function readPhotoUrl(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 1000) {
    throw new HttpError(400, "프로필 이미지 주소가 올바르지 않습니다.", "invalid_profile");
  }
  return value;
}

function readPromptCategories(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(400, "주제 설정이 올바르지 않습니다.", "invalid_prompt_preferences");
  }
  const categories = [...new Set(value.filter((item) => typeof item === "string"))];
  if (categories.some((category) => !PROMPT_CATEGORIES.includes(category))) {
    throw new HttpError(400, "주제 설정에 없는 카테고리가 있습니다.", "invalid_prompt_preferences");
  }
  return categories;
}

function dateRange(query = {}) {
  const to = query.to || todayUtc();
  if (!validDate(to)) {
    throw new HttpError(400, "끝 날짜가 올바르지 않습니다.", "invalid_date");
  }
  const from = query.from || shiftDate(to, -364);
  if (!validDate(from)) {
    throw new HttpError(400, "시작 날짜가 올바르지 않습니다.", "invalid_date");
  }
  if (from > to) {
    throw new HttpError(400, "시작 날짜는 끝 날짜보다 빠르거나 같아야 합니다.", "invalid_date_range");
  }
  return { from, to };
}

function shiftDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dailyPrompt(date, categories = []) {
  const available = categories.length
    ? PROMPTS.filter((prompt) => categories.includes(prompt.category))
    : PROMPTS;
  const list = available.length ? available : PROMPTS;
  const seed = [...date].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return list[seed % list.length];
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
  const entryDate = row.entry_date ? String(row.entry_date).slice(0, 10) : null;
  return {
    id: row.id,
    room_id: row.room_id,
    firebase_uid: row.firebase_uid,
    member_uid: row.firebase_uid,
    entry_date: entryDate,
    date: entryDate,
    content: row.content,
    mood_emoji: row.mood_emoji ?? null,
    mood_color: row.mood_color ?? null,
    is_public: row.is_public ?? false,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function sharedEntryJson(row, callerUid) {
  const entry = entryJson(row);
  const isLocked = row.firebase_uid !== callerUid && !row.caller_has_entry;
  return {
    ...entry,
    content: isLocked ? null : entry.content,
    is_locked: isLocked,
  };
}

function profileJson(row) {
  if (!row) return null;
  return {
    uid: row.firebase_uid,
    display_name: row.display_name,
    photo_url: row.photo_url || null,
    discoverable: row.discoverable !== false,
  };
}

const PERSONAL_ENTRY_FIELDS = `
  SELECT j.id, j.firebase_uid, j.content, j.created_at,
         COALESCE(m.entry_date, (j.created_at AT TIME ZONE 'Asia/Seoul')::date) AS entry_date,
         m.mood_emoji, m.mood_color, COALESCE(m.is_public, FALSE) AS is_public
    FROM journal_entries j
    LEFT JOIN journal_entry_meta m ON m.entry_id = j.id`;

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
        `${PERSONAL_ENTRY_FIELDS}
          WHERE j.firebase_uid = $1
          ORDER BY entry_date DESC, j.created_at DESC
          LIMIT $2`,
        [req.user.uid, limit],
      );
      res.json({ entries: result.rows.map(entryJson) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/entries", requireAuth, async (req, res, next) => {
    try {
      const content = readContent(req.body?.content);
      const entryDate = readDate(req.body);
      const moodEmoji = readMoodEmoji(req.body?.mood_emoji ?? req.body?.moodEmoji);
      const moodColor = readMoodColor(req.body?.mood_color ?? req.body?.moodColor);
      const isPublic = readBoolean(req.body?.is_public ?? req.body?.isPublic, false);
      const entryId = crypto.randomUUID();
      const entry = await withTransaction(pool, async (db) => {
        const result = await db.query(
          "INSERT INTO journal_entries (id, firebase_uid, content) VALUES ($1, $2, $3) RETURNING id, firebase_uid, content, created_at",
          [entryId, req.user.uid, content],
        );
        await db.query(
          `INSERT INTO journal_entry_meta
             (entry_id, entry_date, mood_emoji, mood_color, is_public)
           VALUES ($1, $2, $3, $4, $5)`,
          [entryId, entryDate, moodEmoji, moodColor, isPublic],
        );
        return {
          ...result.rows[0],
          entry_date: entryDate,
          mood_emoji: moodEmoji,
          mood_color: moodColor,
          is_public: isPublic,
        };
      });
      res.status(201).json({ entry: entryJson(entry) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/entries/calendar", requireAuth, async (req, res, next) => {
    try {
      const { from, to } = dateRange(req.query);
      const result = await pool.query(
        `${PERSONAL_ENTRY_FIELDS}
          WHERE j.firebase_uid = $1
            AND COALESCE(m.entry_date, (j.created_at AT TIME ZONE 'Asia/Seoul')::date) BETWEEN $2 AND $3
          ORDER BY entry_date ASC, j.created_at ASC`,
        [req.user.uid, from, to],
      );
      res.json({ from, to, entries: result.rows.map(entryJson) });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/entries/:id/visibility", requireAuth, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) {
        throw new HttpError(400, "올바르지 않은 기록 ID입니다.", "invalid_entry_id");
      }
      const isPublic = readBoolean(req.body?.is_public ?? req.body?.isPublic);
      const result = await pool.query(
        `INSERT INTO journal_entry_meta (entry_id, entry_date, is_public)
         SELECT id, (created_at AT TIME ZONE 'Asia/Seoul')::date, $3
           FROM journal_entries
          WHERE id = $1 AND firebase_uid = $2
         ON CONFLICT (entry_id)
         DO UPDATE SET is_public = EXCLUDED.is_public
         RETURNING entry_id, entry_date, mood_emoji, mood_color, is_public`,
        [req.params.id, req.user.uid, isPublic],
      );
      if (!result.rowCount) {
        throw new HttpError(404, "기록을 찾을 수 없습니다.", "entry_not_found");
      }
      res.json({ metadata: result.rows[0] });
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

  app.get("/api/prompts/today", requireAuth, async (req, res, next) => {
    try {
      const date = req.query.date || todayUtc();
      if (!validDate(date)) {
        throw new HttpError(400, "주제 날짜가 올바르지 않습니다.", "invalid_date");
      }
      const preferences = await pool.query(
        "SELECT categories FROM user_prompt_preferences WHERE firebase_uid = $1",
        [req.user.uid],
      );
      const categories = preferences.rows[0]?.categories || [];
      res.json({ date, prompt: dailyPrompt(date, categories), categories });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/me/prompt-preferences", requireAuth, async (req, res, next) => {
    try {
      const result = await pool.query(
        "SELECT categories, updated_at FROM user_prompt_preferences WHERE firebase_uid = $1",
        [req.user.uid],
      );
      res.json({ categories: result.rows[0]?.categories || [], updated_at: result.rows[0]?.updated_at || null });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/me/prompt-preferences", requireAuth, async (req, res, next) => {
    try {
      const categories = readPromptCategories(req.body?.categories);
      const result = await pool.query(
        `INSERT INTO user_prompt_preferences (firebase_uid, categories, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (firebase_uid)
         DO UPDATE SET categories = EXCLUDED.categories, updated_at = NOW()
         RETURNING categories, updated_at`,
        [req.user.uid, categories],
      );
      res.json({ categories: result.rows[0].categories, updated_at: result.rows[0].updated_at });
    } catch (error) {
      next(error);
    }
  });

  async function getRoomPrompt(req, res, next) {
    try {
      const roomId = readRoomId(req.params.roomId);
      await requireMembership(pool, roomId, req.user.uid);
      const date = req.query.date || todayUtc();
      if (!validDate(date)) {
        throw new HttpError(400, "주제 날짜가 올바르지 않습니다.", "invalid_date");
      }
      res.json({ date, prompt: dailyPrompt(date) });
    } catch (error) {
      next(error);
    }
  }
  app.get("/api/rooms/:roomId/prompt", requireAuth, getRoomPrompt);
  app.get("/api/diaries/:roomId/prompt", requireAuth, getRoomPrompt);

  app.get("/api/me/profile", requireAuth, async (req, res, next) => {
    try {
      const result = await pool.query(
        "SELECT firebase_uid, display_name, photo_url, discoverable, updated_at FROM public_profiles WHERE firebase_uid = $1",
        [req.user.uid],
      );
      res.json({
        has_profile: Boolean(result.rows[0]),
        profile: profileJson(result.rows[0]) || {
          uid: req.user.uid,
          display_name: req.user.name || "하루 기록자",
          photo_url: req.user.picture,
          discoverable: true,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/me/profile", requireAuth, async (req, res, next) => {
    try {
      const displayName = readDisplayName(
        req.body?.display_name ?? req.body?.displayName ?? req.user.name,
      );
      const photoUrl = readPhotoUrl(req.body?.photo_url ?? req.body?.photoURL ?? req.user.picture);
      const discoverable = readBoolean(req.body?.discoverable, true);
      const result = await pool.query(
        `INSERT INTO public_profiles
           (firebase_uid, display_name, photo_url, discoverable, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (firebase_uid)
         DO UPDATE SET display_name = EXCLUDED.display_name,
                       photo_url = EXCLUDED.photo_url,
                       discoverable = EXCLUDED.discoverable,
                       updated_at = NOW()
         RETURNING firebase_uid, display_name, photo_url, discoverable, updated_at`,
        [req.user.uid, displayName, photoUrl, discoverable],
      );
      res.json({ profile: profileJson(result.rows[0]) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/users/search", requireAuth, async (req, res, next) => {
    try {
      const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
      if (!query) return res.json({ users: [] });
      const result = await pool.query(
        `SELECT p.firebase_uid, p.display_name, p.photo_url, p.discoverable,
                f.id AS follow_request_id, f.status AS follow_status
           FROM public_profiles p
           LEFT JOIN follow_requests f
             ON ((f.follower_uid = $1 AND f.following_uid = p.firebase_uid)
              OR (f.follower_uid = p.firebase_uid AND f.following_uid = $1))
          WHERE p.firebase_uid <> $1
            AND p.discoverable = TRUE
            AND p.display_name ILIKE $2
          ORDER BY p.display_name ASC
          LIMIT 20`,
        [req.user.uid, `%${query}%`],
      );
      res.json({ users: result.rows.map((row) => ({
        ...profileJson(row),
        follow_request_id: row.follow_request_id || null,
        follow_status: row.follow_status || "none",
      })) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/me/follow-requests", requireAuth, async (req, res, next) => {
    try {
      const [incoming, outgoing] = await Promise.all([
        pool.query(
          `SELECT f.id, f.status, f.created_at,
                  p.firebase_uid, p.display_name, p.photo_url, p.discoverable
             FROM follow_requests f
             JOIN public_profiles p ON p.firebase_uid = f.follower_uid
            WHERE f.following_uid = $1 AND f.status = 'pending'
            ORDER BY f.created_at DESC`,
          [req.user.uid],
        ),
        pool.query(
          `SELECT f.id, f.status, f.created_at,
                  p.firebase_uid, p.display_name, p.photo_url, p.discoverable
             FROM follow_requests f
             JOIN public_profiles p ON p.firebase_uid = f.following_uid
            WHERE f.follower_uid = $1
            ORDER BY f.updated_at DESC`,
          [req.user.uid],
        ),
      ]);
      const mapRequest = (row) => ({
        id: row.id,
        status: row.status,
        created_at: row.created_at,
        user: profileJson(row),
      });
      res.json({ incoming: incoming.rows.map(mapRequest), outgoing: outgoing.rows.map(mapRequest) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/users/:uid/follow", requireAuth, async (req, res, next) => {
    try {
      const targetUid = readUserId(req.params.uid);
      if (targetUid === req.user.uid) {
        throw new HttpError(400, "자기 자신은 팔로우할 수 없습니다.", "cannot_follow_self");
      }
      const target = await pool.query(
        "SELECT firebase_uid FROM public_profiles WHERE firebase_uid = $1 AND discoverable = TRUE",
        [targetUid],
      );
      if (!target.rowCount) {
        throw new HttpError(404, "공개 프로필을 찾을 수 없습니다.", "profile_not_found");
      }
      const existing = await pool.query(
        `SELECT id, follower_uid, following_uid, status
           FROM follow_requests
          WHERE (follower_uid = $1 AND following_uid = $2)
             OR (follower_uid = $2 AND following_uid = $1)`,
        [req.user.uid, targetUid],
      );
      let result;
      if (existing.rows[0]?.status === "accepted") {
        result = existing.rows[0];
      } else if (existing.rows[0] && existing.rows[0].follower_uid !== req.user.uid) {
        throw new HttpError(409, "상대가 보낸 친구 요청을 먼저 확인해 주세요.", "incoming_follow_request");
      } else if (existing.rows[0]) {
        result = (await pool.query(
          `UPDATE follow_requests
              SET status = 'pending', updated_at = NOW()
            WHERE id = $1
          RETURNING id, status`,
          [existing.rows[0].id],
        )).rows[0];
      } else {
        result = (await pool.query(
          `INSERT INTO follow_requests
             (id, follower_uid, following_uid, status)
           VALUES ($1, $2, $3, 'pending')
           RETURNING id, status`,
          [crypto.randomUUID(), req.user.uid, targetUid],
        )).rows[0];
      }
      res.status(existing.rows[0] ? 200 : 201).json({ follow_request: result });
    } catch (error) {
      next(error);
    }
  });

  async function updateFollowRequest(req, res, next, status) {
    try {
      if (!isUuid(req.params.id)) {
        throw new HttpError(400, "팔로우 요청 ID가 올바르지 않습니다.", "invalid_follow_request");
      }
      const result = await pool.query(
        `UPDATE follow_requests
            SET status = $2, updated_at = NOW()
          WHERE id = $1 AND following_uid = $3 AND status = 'pending'
        RETURNING id, status`,
        [req.params.id, status, req.user.uid],
      );
      if (!result.rowCount) {
        throw new HttpError(404, "처리할 팔로우 요청을 찾을 수 없습니다.", "follow_request_not_found");
      }
      res.json({ follow_request: result.rows[0] });
    } catch (error) {
      next(error);
    }
  }

  app.post("/api/follow-requests/:id/accept", requireAuth, (req, res, next) => updateFollowRequest(req, res, next, "accepted"));
  app.post("/api/follow-requests/:id/reject", requireAuth, (req, res, next) => updateFollowRequest(req, res, next, "rejected"));

  app.delete("/api/follows/:uid", requireAuth, async (req, res, next) => {
    try {
      const targetUid = readUserId(req.params.uid);
      const result = await pool.query(
        `DELETE FROM follow_requests
          WHERE ((status = 'accepted'
            AND ((follower_uid = $1 AND following_uid = $2)
              OR (follower_uid = $2 AND following_uid = $1)))
            OR (status = 'pending' AND follower_uid = $1 AND following_uid = $2))
          RETURNING id`,
        [req.user.uid, targetUid],
      );
      if (!result.rowCount) {
        throw new HttpError(404, "팔로우 관계를 찾을 수 없습니다.", "follow_not_found");
      }
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/feed", requireAuth, async (req, res, next) => {
    try {
      const limit = readLimit(req.query.limit, 50, 100);
      const result = await pool.query(
        `${PERSONAL_ENTRY_FIELDS.replace("WHERE", "")}
         JOIN public_profiles p ON p.firebase_uid = j.firebase_uid
         JOIN follow_requests f
           ON ((f.following_uid = j.firebase_uid AND f.follower_uid = $1)
            OR (f.follower_uid = j.firebase_uid AND f.following_uid = $1))
          AND f.status = 'accepted'
        WHERE m.is_public = TRUE
        ORDER BY entry_date DESC, j.created_at DESC
        LIMIT $2`,
        [req.user.uid, limit],
      );
      res.json({ entries: result.rows.map((row) => ({
        ...entryJson(row),
        author: profileJson(row),
      })) });
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
          `SELECT id, room_id, firebase_uid, entry_date, content, created_at, updated_at,
                  EXISTS (
                    SELECT 1 FROM shared_diary_entries caller_entry
                     WHERE caller_entry.room_id = recent.room_id
                       AND caller_entry.entry_date = recent.entry_date
                       AND caller_entry.firebase_uid = $2
                  ) AS caller_has_entry
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
          [rooms.map((room) => room.id), req.user.uid],
        );
        const byRoom = new Map(rooms.map((room) => [room.id, []]));
        for (const row of recentResult.rows) {
          byRoom.get(row.room_id)?.push(sharedEntryJson(row, req.user.uid));
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
          `SELECT id, room_id, firebase_uid, entry_date, content, created_at, updated_at,
                  EXISTS (
                    SELECT 1 FROM shared_diary_entries caller_entry
                     WHERE caller_entry.room_id = shared_diary_entries.room_id
                       AND caller_entry.entry_date = shared_diary_entries.entry_date
                       AND caller_entry.firebase_uid = $2
                  ) AS caller_has_entry
             FROM shared_diary_entries
            WHERE room_id = $1
            ORDER BY entry_date DESC, updated_at DESC
            LIMIT 365`,
          [roomId, req.user.uid],
        ),
      ]);

      const row = roomResult.rows[0];
      const room = roomJson(
        { ...row, role: membership.role, member_count: membersResult.rows.length },
        { recent_entries: entriesResult.rows.slice(0, 6).map((entry) => sharedEntryJson(entry, req.user.uid)) },
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
        entries: entriesResult.rows.map((entry) => sharedEntryJson(entry, req.user.uid)),
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
        `SELECT id, room_id, firebase_uid, entry_date, content, created_at, updated_at,
                EXISTS (
                  SELECT 1 FROM shared_diary_entries caller_entry
                   WHERE caller_entry.room_id = shared_diary_entries.room_id
                     AND caller_entry.entry_date = shared_diary_entries.entry_date
                     AND caller_entry.firebase_uid = $3
                ) AS caller_has_entry
           FROM shared_diary_entries
          WHERE room_id = $1
          ORDER BY entry_date DESC, updated_at DESC
          LIMIT $2`,
        [roomId, limit, req.user.uid],
      );
      res.json({ entries: result.rows.map((entry) => sharedEntryJson(entry, req.user.uid)) });
    } catch (error) {
      next(error);
    }
  }

  app.get("/api/rooms/:roomId/entries", requireAuth, listRoomEntries);
  app.get("/api/rooms/:roomId/history", requireAuth, listRoomEntries);
  app.get("/api/diaries/:roomId/entries", requireAuth, listRoomEntries);
  app.get("/api/diaries/:roomId/history", requireAuth, listRoomEntries);

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
