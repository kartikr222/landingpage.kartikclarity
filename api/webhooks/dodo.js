const { Webhook } = require("svix");
const { neon } = require("@neondatabase/serverless");

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
};

const PRODUCTS = [
  { env: "DODO_PRODUCT_ID_WORKBOOK_19", key: "workbook_19", name: "Revenue Leak Workbook" },
  { env: "DODO_PRODUCT_ID_TOOLKIT_27", key: "toolkit_27", name: "Revenue Leak Toolkit" },
  { env: "DODO_PRODUCT_ID_ASSESSMENT_995", key: "assessment_995", name: "Executive Revenue Leak Assessment" },
  { env: "DODO_PRODUCT_ID_AUDIT_9500", key: "audit_9500", name: "Executive Revenue Leak Audit" },
];

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Method not allowed" });
  }
  if (!process.env.DODO_WEBHOOK_SECRET || !process.env.DATABASE_URL) {
    return json(res, 503, { error: "Payment webhook is not configured." });
  }

  let rawBody = "";
  try {
    for await (const chunk of req) rawBody += chunk.toString("utf8");
  } catch (_) {
    return json(res, 400, { error: "Invalid request body." });
  }

  let event;
  try {
    const verifier = new Webhook(process.env.DODO_WEBHOOK_SECRET);
    event = verifier.verify(rawBody, {
      "webhook-id": req.headers["webhook-id"],
      "webhook-timestamp": req.headers["webhook-timestamp"],
      "webhook-signature": req.headers["webhook-signature"],
    });
  } catch (_) {
    return json(res, 401, { error: "Webhook signature verification failed." });
  }

  // Only grant access for a verified successful one-time payment.
  if (!event || event.type !== "payment.succeeded") {
    return json(res, 200, { received: true, processed: false });
  }

  const data = event.data || {};
  const email = String(data.customer && data.customer.email || data.customer_email || "")
    .trim().toLowerCase();
  const paymentId = String(data.payment_id || data.id || "").trim();

  if (!email || !paymentId || !email.includes("@")) {
    return json(res, 200, { received: true, processed: false, reason: "Missing customer email or payment ID." });
  }

  const cart = Array.isArray(data.product_cart) ? data.product_cart : [];
  const ids = new Set();
  if (data.product_id) ids.add(String(data.product_id));
  for (const item of cart) {
    if (item && item.product_id) ids.add(String(item.product_id));
  }

  const configured = PRODUCTS
    .filter((product) => process.env[product.env] && ids.has(String(process.env[product.env])));

  if (!configured.length) {
    // Unknown/unmapped products never grant access by default.
    return json(res, 200, { received: true, processed: false, reason: "No configured product mapping matched." });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);
    for (const product of configured) {
      await sql`
        INSERT INTO purchase_entitlements
          (provider, payment_id, product_id, entitlement_key, product_name, customer_email, purchased_at)
        VALUES
          ('dodo', ${paymentId}, ${String(process.env[product.env])},
           ${product.key}, ${product.name}, ${email}, now())
        ON CONFLICT (provider, payment_id, product_id)
        DO UPDATE SET customer_email = EXCLUDED.customer_email
      `;
    }
    return json(res, 200, { received: true, processed: true, grants: configured.length });
  } catch (_) {
    return json(res, 500, { error: "Could not record the verified purchase." });
  }
};

module.exports.config = { api: { bodyParser: false } };
