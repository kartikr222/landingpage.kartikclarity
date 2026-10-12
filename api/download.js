const { verifyToken, createClerkClient } = require("@clerk/backend");
const { neon } = require("@neondatabase/serverless");
const { Readable } = require("node:stream");

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(body));
};

async function getIdentity(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const claims = await verifyToken(match[1], {
    secretKey: process.env.CLERK_SECRET_KEY,
    authorizedParties: ["https://kartikclarity.vercel.app"],
  });
  if (!claims || !claims.sub) return null;

  const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  const user = await clerk.users.getUser(claims.sub);
  const emails = (user.emailAddresses || [])
    .filter((entry) => entry.verification && entry.verification.status === "verified")
    .map((entry) => String(entry.emailAddress || "").trim().toLowerCase())
    .filter(Boolean);
  return { userId: claims.sub, emails };
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: "Method not allowed" });
  }

  if (process.env.WORKSPACE_ENABLED !== "true" ||
      !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||
      !process.env.CLERK_SECRET_KEY ||
      !process.env.DATABASE_URL ||
      !process.env.BLOB_READ_WRITE_TOKEN) {
    return json(res, 503, { error: "Secure downloads are not configured." });
  }

  const fileId = String((req.query && req.query.fileId) || "");
  if (!/^\d{1,18}$/.test(fileId)) {
    return json(res, 404, { error: "File not found." });
  }

  let identity;
  try {
    identity = await getIdentity(req);
  } catch (_) {
    return json(res, 401, { error: "A valid sign-in session is required." });
  }
  if (!identity || !identity.emails.length) {
    return json(res, 401, { error: "A verified sign-in session is required." });
  }

  try {
    const emailClause = identity.emails
      .map((_, index) => "$" + (index + 2))
      .join(", ");
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql.query(
      `SELECT f.blob_pathname, f.file_name, f.content_type, f.size_bytes
       FROM private_product_files AS f
       WHERE f.id = $1 AND f.active = TRUE
         AND EXISTS (
           SELECT 1
           FROM purchase_entitlements AS entitlement
           WHERE entitlement.product_id = f.product_id
             AND entitlement.provider = 'dodo'
             AND entitlement.status = 'active'
             AND lower(entitlement.customer_email) IN (${emailClause})
         )
       LIMIT 1`,
      [Number(fileId), ...identity.emails]
    );

    // Deliberately return the same 404 for missing files and missing entitlements.
    if (!rows.length) return json(res, 404, { error: "File not found." });

    const { get } = await import("@vercel/blob");
    const blob = await get(rows[0].blob_pathname, {
      access: "private",
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    if (!blob || blob.statusCode !== 200 || !blob.stream) {
      return json(res, 404, { error: "File not found." });
    }

    const allowedTypes = new Set([
      "application/pdf",
      "application/zip",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]);
    const contentType = allowedTypes.has(rows[0].content_type)
      ? rows[0].content_type
      : "application/octet-stream";
    const fileName = String(rows[0].file_name || "download")
      .replace(/[\r\n"\\]/g, "_")
      .slice(0, 180) || "download";

    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", "attachment; filename=\"" + fileName + "\"; filename*=UTF-8''" + encodeURIComponent(fileName));
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    if (Number.isSafeInteger(Number(blob.blob && blob.blob.size))) {
      res.setHeader("Content-Length", String(blob.blob.size));
    }
    Readable.fromWeb(blob.stream).pipe(res);
  } catch (_) {
    return json(res, 503, { error: "The download could not be prepared. Please try again later." });
  }
};
