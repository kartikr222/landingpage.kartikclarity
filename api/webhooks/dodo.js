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

  const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
  let rawBody = "";
  let rawBodyBytes = 0;
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      rawBodyBytes += buffer.length;
      if (rawBodyBytes > MAX_WEBHOOK_BODY_BYTES) {
        return json(res, 413, { error: "Webhook payload is too large." });
      }
      rawBody += buffer.toString("utf8");
    }
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

  if (!event || typeof event.type !== "string" || !event.data) {
    return json(res, 400, { error: "Malformed signed webhook event." });
  }

  const data = event.data;
  const paymentId = String(data.payment_id || data.id || "").trim();
  const sql = neon(process.env.DATABASE_URL);

  try {
    if (event.type === "payment.succeeded") {
      const email = String(data.customer && data.customer.email || data.customer_email || "")
        .trim().toLowerCase();

      if (!email || !paymentId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json(res, 422, { error: "Successful payment is missing a valid customer email or payment ID." });
      }

      const cart = Array.isArray(data.product_cart) ? data.product_cart : [];
      const ids = new Set();
      if (data.product_id) ids.add(String(data.product_id));
      for (const item of cart) {
        if (item && item.product_id) ids.add(String(item.product_id));
      }

      const configured = PRODUCTS.filter(
        (product) => process.env[product.env] && ids.has(String(process.env[product.env]))
      );
      if (!configured.length) {
        // Unknown/unmapped products never grant access by default.
        return json(res, 200, { received: true, processed: false, reason: "No configured product mapping matched." });
      }

      // Do not let a late/duplicate success event undo an earlier refund/dispute.
      await sql`
        INSERT INTO payment_lifecycle (provider, payment_id, status, status_reason, updated_at)
        VALUES ('dodo', ${paymentId}, 'active', 'payment.succeeded', now())
        ON CONFLICT (provider, payment_id) DO NOTHING
      `;
      const lifecycle = await sql`
        SELECT status FROM payment_lifecycle
        WHERE provider = 'dodo' AND payment_id = ${paymentId}
        LIMIT 1
      `;
      if (!lifecycle.length || lifecycle[0].status !== "active") {
        return json(res, 200, { received: true, processed: false, reason: "Payment is not in an active entitlement state." });
      }

      for (const product of configured) {
        await sql`
          INSERT INTO purchase_entitlements
            (provider, payment_id, product_id, entitlement_key, product_name, customer_email,
             status, status_reason, status_updated_at, purchased_at)
          VALUES
            ('dodo', ${paymentId}, ${String(process.env[product.env])},
             ${product.key}, ${product.name}, ${email}, 'active', 'payment.succeeded', now(), now())
          ON CONFLICT (provider, payment_id, product_id) DO NOTHING
        `;
      }
      // Reconcile after inserts as well as before them. A refund/dispute can race
      // with payment.succeeded: if its entitlement UPDATE ran before this insert,
      // this final sync prevents the newly inserted row from staying active.
      await sql`
        UPDATE purchase_entitlements AS entitlement
        SET status = lifecycle.status,
            status_reason = lifecycle.status_reason,
            status_updated_at = now()
        FROM payment_lifecycle AS lifecycle
        WHERE entitlement.provider = 'dodo'
          AND entitlement.payment_id = ${paymentId}
          AND lifecycle.provider = entitlement.provider
          AND lifecycle.payment_id = entitlement.payment_id
          AND entitlement.status IS DISTINCT FROM lifecycle.status
      `;
      const finalLifecycle = await sql`
        SELECT status FROM payment_lifecycle
        WHERE provider = 'dodo' AND payment_id = ${paymentId}
        LIMIT 1
      `;
      if (!finalLifecycle.length || finalLifecycle[0].status !== "active") {
        return json(res, 200, {
          received: true,
          processed: false,
          reason: "Payment lifecycle changed during fulfillment; entitlements were reconciled.",
        });
      }
      return json(res, 200, { received: true, processed: true, matchedProducts: configured.length });
    }

    // A successful full refund revokes access; partial refunds do not automatically
    // remove a digital entitlement. The signed event contains the associated payment ID.
    if (event.type === "refund.succeeded") {
      if (!paymentId) return json(res, 422, { error: "Refund event is missing its payment ID." });
      if (data.is_partial === true) {
        return json(res, 200, { received: true, processed: false, reason: "Partial refund; entitlement retained." });
      }
      await sql`
        INSERT INTO payment_lifecycle (provider, payment_id, status, status_reason, updated_at)
        VALUES ('dodo', ${paymentId}, 'revoked', 'refund.succeeded', now())
        ON CONFLICT (provider, payment_id)
        DO UPDATE SET status = 'revoked', status_reason = 'refund.succeeded', updated_at = now()
      `;
      await sql`
        UPDATE purchase_entitlements
        SET status = 'revoked', status_reason = 'refund.succeeded', status_updated_at = now()
        WHERE provider = 'dodo' AND payment_id = ${paymentId}
      `;
      return json(res, 200, { received: true, processed: true, action: "access_revoked" });
    }

    if (event.type.startsWith("dispute.")) {
      if (!paymentId) return json(res, 422, { error: "Dispute event is missing its payment ID." });

      if (event.type === "dispute.opened" || event.type === "dispute.challenged") {
        await sql`
          INSERT INTO payment_lifecycle (provider, payment_id, status, status_reason, updated_at)
          VALUES ('dodo', ${paymentId}, 'review', ${event.type}, now())
          ON CONFLICT (provider, payment_id)
          DO UPDATE SET status = 'review', status_reason = EXCLUDED.status_reason, updated_at = now()
          WHERE payment_lifecycle.status <> 'revoked'
        `;
        await sql`
          UPDATE purchase_entitlements
          SET status = 'review', status_reason = ${event.type}, status_updated_at = now()
          WHERE provider = 'dodo' AND payment_id = ${paymentId} AND status <> 'revoked'
        `;
        return json(res, 200, { received: true, processed: true, action: "access_paused_for_review" });
      }

      if (event.type === "dispute.lost" || event.type === "dispute.accepted" || event.type === "dispute.expired") {
        await sql`
          INSERT INTO payment_lifecycle (provider, payment_id, status, status_reason, updated_at)
          VALUES ('dodo', ${paymentId}, 'revoked', ${event.type}, now())
          ON CONFLICT (provider, payment_id)
          DO UPDATE SET status = 'revoked', status_reason = EXCLUDED.status_reason, updated_at = now()
        `;
        await sql`
          UPDATE purchase_entitlements
          SET status = 'revoked', status_reason = ${event.type}, status_updated_at = now()
          WHERE provider = 'dodo' AND payment_id = ${paymentId}
        `;
        return json(res, 200, { received: true, processed: true, action: "access_revoked" });
      }

      if (event.type === "dispute.won" || event.type === "dispute.cancelled") {
        await sql`
          UPDATE payment_lifecycle
          SET status = 'active', status_reason = 'dispute_resolved', updated_at = now()
          WHERE provider = 'dodo' AND payment_id = ${paymentId}
            AND status = 'review'
            AND status_reason IN ('dispute.opened', 'dispute.challenged')
        `;
        await sql`
          UPDATE purchase_entitlements
          SET status = 'active', status_reason = 'dispute_resolved', status_updated_at = now()
          WHERE provider = 'dodo' AND payment_id = ${paymentId}
            AND status = 'review'
            AND status_reason IN ('dispute.opened', 'dispute.challenged')
        `;
        return json(res, 200, { received: true, processed: true, action: "restore_access_if_review_was_pending" });
      }
    }

    // Acknowledge unrelated signed events without granting access.
    return json(res, 200, { received: true, processed: false });
  } catch (_) {
    // Return 500 so the provider can retry temporary database failures.
    return json(res, 500, { error: "Could not record the verified payment event." });
  }
};

module.exports.config = { api: { bodyParser: false } };
