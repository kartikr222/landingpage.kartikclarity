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
      !process.env.CLERK_SECRET_KEY || !process.env.DATABASE_URL) {
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

    // Use individually parameterized placeholders rather than relying on driver-specific
    // JavaScript-array serialization for PostgreSQL ANY(...).
    const reportEmailClause = emails.length
      ? `lower(owner_email) IN (${emails.map((_, index) => `$${index + 2}`).join(", ")})`
      : "FALSE";
    const reports = await sql.query(
      `SELECT id, title, report_type, score, summary, findings,
              recommendations, action_plan, created_at, updated_at
       FROM workspace_reports
       WHERE owner_clerk_user_id = $1
          OR (owner_clerk_user_id IS NULL AND (${reportEmailClause}))
       ORDER BY created_at DESC
       LIMIT 100`,
      [identity.userId, ...emails]
    );

    const productsConfigured = [
      process.env.DODO_PRODUCT_ID_WORKBOOK_19,
      process.env.DODO_PRODUCT_ID_TOOLKIT_27,
      process.env.DODO_PRODUCT_ID_ASSESSMENT_995,
      process.env.DODO_PRODUCT_ID_AUDIT_9500,
    ].some(Boolean);
    const purchasesAvailable = Boolean(process.env.DODO_WEBHOOK_SECRET && productsConfigured);
    const storageConfigured = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
    let purchases = [];
    if (purchasesAvailable && emails.length) {
      const emailPlaceholders = emails.map((_, index) => "$" + (index + 1)).join(", ");
      const rows = await sql.query(
        "SELECT product_id, entitlement_key, product_name, purchased_at, status, status_reason " +
        "FROM purchase_entitlements WHERE lower(customer_email) IN (" + emailPlaceholders + ") " +
        "ORDER BY purchased_at DESC LIMIT 100",
        emails
      );

      const productIds = [...new Set(rows.map((purchase) => purchase.product_id).filter(Boolean))];
      let files = [];
      if (storageConfigured && productIds.length) {
        const productPlaceholders = productIds.map((_, index) => "$" + (index + 1)).join(", ");
        files = await sql.query(
          "SELECT id, product_id, file_name FROM private_product_files " +
          "WHERE active = TRUE AND product_id IN (" + productPlaceholders + ") " +
          "ORDER BY product_id, file_name LIMIT 200",
          productIds
        );
      }

      const filesByProduct = new Map();
      for (const file of files) {
        const key = String(file.product_id);
        if (!filesByProduct.has(key)) filesByProduct.set(key, []);
        filesByProduct.get(key).push({ id: file.id, file_name: file.file_name });
      }
      purchases = rows.map((purchase) => ({
        ...purchase,
        downloads: purchase.status === "active"
          ? (filesByProduct.get(String(purchase.product_id)) || [])
          : [],
      }));
    }

    return json(res, 200, {
      reports,
      purchases,
      capabilities: {
        reportsAvailable: true,
        purchasesAvailable,
        downloadsAvailable: storageConfigured && purchases.some((purchase) => purchase.downloads.length > 0),
      },
    });
  } catch (_) {
    return json(res, 503, {
      code: "WORKSPACE_TEMPORARILY_UNAVAILABLE",
      message: "Your workspace could not be loaded. Please try again later.",
    });
  }
};
