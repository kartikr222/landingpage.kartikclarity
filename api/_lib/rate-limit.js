const { createHmac } = require("node:crypto");
const { neon } = require("@neondatabase/serverless");

function clientIp(req) {
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) return realIp.trim();
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",").map((part) => part.trim()).filter(Boolean).at(-1) || "unknown";
  }
  return "unknown";
}

function createRateLimiter({ query, secret, now = () => Date.now(), cleanupEvery = 100 }) {
  if (typeof query !== "function") throw new TypeError("A database query function is required.");
  if (typeof secret !== "string" || secret.length < 32) throw new Error("RATE_LIMIT_HASH_SECRET must contain at least 32 characters.");
  let operations = 0;
  return async function consume({ scope, identifier, limit, windowSeconds }) {
    if (!scope || !identifier || !Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowSeconds) || windowSeconds < 1) {
      throw new TypeError("Invalid rate-limit policy.");
    }
    const keyHash = createHmac("sha256", secret).update(String(scope) + ":" + String(identifier)).digest("hex");
    const windowStart = Math.floor(now() / (windowSeconds * 1000));
    const rows = await query(
      "INSERT INTO rate_limit_counters (key_hash, window_start, count, expires_at) " +
      "VALUES ($1, $2, 1, $3::timestamptz) " +
      "ON CONFLICT (key_hash, window_start) DO UPDATE SET count = rate_limit_counters.count + 1 RETURNING count",
      [keyHash, windowStart, new Date((windowStart + 1) * windowSeconds * 1000).toISOString()]
    );
    const count = Number(rows && rows[0] && rows[0].count);
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid rate-limit counter.");
    if (count % cleanupEvery === 0) {
      await query(
        "DELETE FROM rate_limit_counters WHERE ctid IN " +
        "(SELECT ctid FROM rate_limit_counters WHERE expires_at < now() ORDER BY expires_at LIMIT 100)",
        []
      );
    }
    return {
      allowed: count <= limit,
      count,
      retryAfter: Math.max(1, Math.ceil(((windowStart + 1) * windowSeconds * 1000 - now()) / 1000)),
    };
  };
}

async function enforceRateLimit(req, res, policies, options = {}) {
  const failClosed = options.failClosed === true;
  const secret = process.env.RATE_LIMIT_HASH_SECRET;
  if (!process.env.DATABASE_URL || typeof secret !== "string" || secret.length < 32) {
    if (!failClosed) return true;
    res.setHeader("Cache-Control", "no-store");
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Request protection is not configured." }));
    return false;
  }
  try {
    const sql = neon(process.env.DATABASE_URL);
    const consume = createRateLimiter({ query: (statement, params) => sql.query(statement, params), secret });
    for (const policy of policies) {
      const result = await consume(policy);
      if (!result.allowed) {
        res.setHeader("Retry-After", String(result.retryAfter));
        res.setHeader("Cache-Control", "no-store");
        res.statusCode = 429;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "Too many requests. Please try again shortly." }));
        return false;
      }
    }
    return true;
  } catch (_) {
    if (!failClosed) return true;
    res.setHeader("Cache-Control", "no-store");
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Request protection is temporarily unavailable." }));
    return false;
  }
}

module.exports = { clientIp, createRateLimiter, enforceRateLimit };
