import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { createAuthMiddleware } from "./auth.js";

function allowedOrigin(origin) {
  if (!origin) return true;

  const configured = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (configured.includes(origin)) return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return /^https:\/\/haru-one-line(?:-[a-z0-9-]+)?\.vercel\.app$/.test(origin);
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

  app.get("/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok", database: "connected" });
    } catch {
      res.status(503).json({ status: "error", database: "disconnected" });
    }
  });

  const requireAuth = createAuthMiddleware(verifyToken);

  app.get("/api/entries", requireAuth, async (req, res, next) => {
    try {
      const result = await pool.query(
        "SELECT id, content, created_at FROM journal_entries WHERE firebase_uid = $1 ORDER BY created_at DESC LIMIT 100",
        [req.user.uid],
      );
      res.json({ entries: result.rows });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/entries", requireAuth, async (req, res, next) => {
    const content = typeof req.body.content === "string" ? req.body.content.trim() : "";
    if (!content || content.length > 60) {
      return res.status(400).json({ error: "기록은 1~60자로 입력해 주세요." });
    }

    try {
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
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
      return res.status(400).json({ error: "올바르지 않은 기록 ID입니다." });
    }

    try {
      const result = await pool.query(
        "DELETE FROM journal_entries WHERE id = $1 AND firebase_uid = $2",
        [req.params.id, req.user.uid],
      );
      if (!result.rowCount) {
        return res.status(404).json({ error: "기록을 찾을 수 없습니다." });
      }
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ error: "서버에서 문제가 발생했습니다." });
  });

  return app;
}
