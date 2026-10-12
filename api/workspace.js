const { verifyToken, createClerkClient } = require("@clerk/backend");
const { neon } = require("@neondatabase/serverless");

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, private");
  res.end(JSON.stringify(body));
};

async function getIdentity(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const claims = await verifyToken(match[1], {
    secretKey: process.env.CLERK_SECRET_KEY,
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

  if (!process.env.CLERK_SECRET_KEY || !process.env.DATABASE_URL) {
    return json(res, 503, {
      code: "WORKSPACE_NOT_CONFIGURED",
      message: "The Client Workspace is not available yet. Please contact info.kartikclarity@gmail.com for help.",
    });
  }

  let identity;
  try {
    identity = await getIdentity(req);
  } catch (_) {
    return json(res, 401, { error: "A valid sign-in session is required." });
  }
  if (!identity) return json(res, 401, { error: "A valid sign-in session is required." });

  try {
    const sql = neon(process.env.DATABASE_URL);
    const emails = identity.emails;
    const reports = await sql`
      SELECT id, title, report_type, score, summary, findings,
             recommendations, action_plan, created_at, updated_at
      FROM workspace_reports
      WHERE owner_clerk_user_id = ${identity.userId}
         OR (owner_clerk_user_id IS NULL AND cardinality(${emails}::text[]) > 0
             AND lower(owner_email) = ANY(${emails}::text[]))
      ORDER BY created_at DESC
      LIMIT 100
    `;

    const productsConfigured = [
      process.env.DODO_PRODUCT_ID_WORKBOOK_19,
      process.env.DODO_PRODUCT_ID_TOOLKIT_27,
      process.env.DODO_PRODUCT_ID_ASSESSMENT_995,
      process.env.DODO_PRODUCT_ID_AUDIT_9500,
    ].some(Boolean);
    const purchasesAvailable = Boolean(process.env.DODO_WEBHOOK_SECRET && productsConfigured);
    const purchases = purchasesAvailable ? await sql`
      SELECT entitlement_key, product_name, purchased_at
      FROM purchase_entitlements
      WHERE lower(customer_email) = ANY(${emails}::text[])
      ORDER BY purchased_at DESC
      LIMIT 100
    ` : [];

    return json(res, 200, {
      reports,
      purchases,
      capabilities: {
        reportsAvailable: true,
        purchasesAvailable,
        downloadsAvailable: false,
      },
    });
  } catch (_) {
    return json(res, 503, {
      code: "WORKSPACE_TEMPORARILY_UNAVAILABLE",
      message: "Your workspace could not be loaded. Please try again later.",
    });
  }
};
