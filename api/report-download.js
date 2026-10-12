const { verifyToken, createClerkClient } = require("@clerk/backend");
const { neon } = require("@neondatabase/serverless");
const { Readable } = require("node:stream");
const { clientIp, enforceRateLimit } = require("./_lib/rate-limit");

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(body));
}

async function identity(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const claims = await verifyToken(match[1], {
    secretKey: process.env.CLERK_SECRET_KEY,
    authorizedParties: ["https://kartikclarity.vercel.app"],
  });
  if (!claims || !claims.sub) return null;
  const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  const user = await clerk.users.getUser(claims.sub);
  const emails = (user.emailAddresses || []).filter((e) => e.verification && e.verification.status === "verified");
  return { userId: claims.sub, emails: emails.map((entry) => String(entry.emailAddress || "").trim().toLowerCase()).filter(Boolean) };
}

module.exports = async (req, res) => {
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return json(res, 405, { error: "Method not allowed" }); }
  if (process.env.WORKSPACE_ENABLED !== "true" || !process.env.CLERK_SECRET_KEY || !process.env.DATABASE_URL || !process.env.BLOB_READ_WRITE_TOKEN) {
    return json(res, 503, { error: "Secure report downloads are not configured." });
  }
  if (!(await enforceRateLimit(req, res, [{ scope: "report-download-ip", identifier: clientIp(req), limit: 20, windowSeconds: 60 }], { failClosed: true }))) return;
  const fileId = String((req.query && req.query.fileId) || "");
  if (!/^[1-9]\d{0,18}$/.test(fileId)) return json(res, 404, { error: "File not found." });
  let user;
  try { user = await identity(req); } catch (_) { return json(res, 401, { error: "A valid sign-in session is required." }); }
  if (!user || !user.emails.length) return json(res, 401, { error: "A verified sign-in session is required." });
  if (!(await enforceRateLimit(req, res, [{ scope: "report-download-user", identifier: user.userId, limit: 60, windowSeconds: 600 }], { failClosed: true }))) return;
  try {
    const sql = neon(process.env.DATABASE_URL);
    const emailPlaceholders = user.emails.map((_, index) => "$" + (index + 3)).join(", ");
    const rows = await sql.query(
      "SELECT f.blob_pathname, f.file_name, f.content_type FROM private_report_files f " +
      "JOIN workspace_reports r ON r.id = f.report_id " +
      "WHERE f.id = $1 AND f.active = TRUE AND f.owner_clerk_user_id = $2 AND r.owner_clerk_user_id = $2 " +
      "AND EXISTS (SELECT 1 FROM purchase_entitlements e WHERE e.product_id = f.product_id " +
      "AND e.provider = 'dodo' AND e.status = 'active' AND lower(e.customer_email) IN (" + emailPlaceholders + ")) LIMIT 1",
      [fileId, user.userId, ...user.emails]
    );
    if (!rows.length) return json(res, 404, { error: "File not found." });
    const { get } = await import("@vercel/blob");
    const blob = await get(rows[0].blob_pathname, { access: "private", token: process.env.BLOB_READ_WRITE_TOKEN });
    if (!blob || blob.statusCode !== 200 || !blob.stream) return json(res, 404, { error: "File not found." });
    const allowed = new Set(["application/pdf", "application/zip", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);
    const type = allowed.has(rows[0].content_type) ? rows[0].content_type : "application/octet-stream";
    const name = String(rows[0].file_name || "report").replace(/[\r\n"\\]/g, "_").slice(0, 180) || "report";
    const fallback = name.replace(/[^\x20-\x7E]/g, "_");
    const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
    res.statusCode = 200;
    res.setHeader("Content-Type", type);
    res.setHeader("Content-Disposition", "attachment; filename=\"" + fallback + "\"; filename*=UTF-8''" + encoded);
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    const size = blob.blob && blob.blob.size;
    if (Number.isSafeInteger(size) && size >= 0) res.setHeader("Content-Length", String(size));
    Readable.fromWeb(blob.stream).pipe(res);
  } catch (_) { return json(res, 503, { error: "The report download could not be prepared. Please try again later." }); }
};
