import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

export function createFirebaseVerifier(
  projectId = process.env.FIREBASE_PROJECT_ID,
) {
  if (!projectId) {
    throw new Error("FIREBASE_PROJECT_ID 환경변수가 필요합니다.");
  }

  const app = getApps()[0] || initializeApp({ projectId });
  return (token) => getAuth(app).verifyIdToken(token);
}

export function createAuthMiddleware(verifyToken) {
  return async (req, res, next) => {
    const match = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res.status(401).json({ error: "로그인이 필요합니다." });
    }

    try {
      const decoded = await verifyToken(match[1]);
      req.user = { uid: decoded.uid, email: decoded.email || null };
      next();
    } catch (error) {
      console.warn("Invalid Firebase token:", error.code || error.message);
      res.status(401).json({
        error: "로그인 정보가 만료되었거나 올바르지 않습니다.",
      });
    }
  };
}
