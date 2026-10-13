#!/usr/bin/env python3
"""Static security invariants for the setup-gated client workspace."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
checks = 0
errors = []

def check(condition, message):
    global checks
    checks += 1
    if not condition:
        errors.append(message)

def read(path):
    target = ROOT / path
    check(target.is_file(), f"Required workspace file missing: {path}")
    return target.read_text(encoding="utf-8") if target.is_file() else ""

config = read("api/config.js")
workspace = read("api/workspace.js")
webhook = read("api/webhooks/dodo.js")
download = read("api/download.js")
report_download = read("api/report-download.js")
uploader = read("scripts/upload_private_product.mjs")
report_publisher = read("scripts/publish_client_report.mjs")
assessment = read("api/assessment.js")
schema = read("db/schema.sql")
ui = read("workspace/index.html")
docs = read("WORKSPACE_SETUP.md")
package = read("package.json")

# Release gate: no credentials are embedded in the repository and no UI
# is enabled until an operator explicitly activates the workspace.
check('process.env.WORKSPACE_ENABLED === "true"' in config,
      "Workspace config must require explicit activation")
check("explicitlyEnabled && clerkConfigured && databaseConfigured" in config,
      "Workspace config must require activation, Clerk and database")
check("process.env.WORKSPACE_ENABLED !== \"true\"" in workspace,
      "Private API must independently enforce the workspace release gate")
check("CLERK_SECRET_KEY" not in ui and "DATABASE_URL" not in ui,
      "Browser UI must never contain server secrets or database URLs")
check("workspaceAvailable && scores.every(s=>s!==null)" in read("index.html"),
      "Homepage must only offer saving when workspace is configured and all preview questions are answered")
check("process.env.WORKSPACE_ENABLED !== \"true\"" in assessment,
      "Assessment save endpoint must remain disabled until workspace activation")
check("verifyToken" in assessment and "req.headers.authorization" in assessment,
      "Assessment saving must require a verified sign-in session")
check('authorizedParties: ["https://kartikclarity.vercel.app"]' in assessment and
      'authorizedParties: ["https://kartikclarity.vercel.app"]' in workspace,
      "Clerk tokens must be restricted to the production origin to reduce cross-origin token reuse")
check("answers.length !== 3" in assessment and "[20, 50, 80]" in assessment,
      "Assessment save endpoint must validate the exact three-question answer schema")
check("source_request_id" in assessment and "workspace_reports_request_id_idx" in schema,
      "Assessment saving must be idempotent per authenticated user and request")
check("Directional preview score" in assessment and "not a full diagnosis" in assessment,
      "Saved assessment preview must be clearly labelled as directional, not a full diagnosis")
check("publishableKey: workspaceReady ? publishableKey : null" in config,
      "Only the publishable Clerk key may be returned to the browser")
check("CLERK_SECRET_KEY" in docs and "DODO_WEBHOOK_SECRET" in docs,
      "Setup guide must document server-side secret provisioning")

# Identity and data isolation.
check("verifyToken" in workspace and "req.headers.authorization" in workspace,
      "Private API must verify a bearer session token")
check('entry.verification.status === "verified"' in workspace,
      "Only verified email addresses may associate purchases/reports")
check("owner_clerk_user_id = $1" in workspace and "[identity.userId, ...emails]" in workspace,
      "Report reads must be scoped to the authenticated Clerk user with a parameterized query")
check("owner_clerk_user_id IS NULL" in workspace,
      "Legacy email ownership must not override a report's explicit user owner")
check('"FROM purchase_entitlements WHERE lower(customer_email) IN ("' in workspace and
      'ORDER BY purchased_at DESC LIMIT 100' in workspace and 'emails' in workspace,
      "Purchase reads must use parameterized verified-email ownership filters")
check("index + 2" in workspace and '"$" + (index + 1)' in workspace,
      "SQL placeholder builders must emit PostgreSQL $N parameters, not bare numbers")
check("DO $$" in schema and "$$;" in schema,
      "PostgreSQL migration blocks must use valid dollar-quote delimiters")
check('meta name="robots" content="noindex,nofollow"' in ui,
      "Workspace UI must be excluded from search indexing")

# Payment fulfillment is only based on signed, mapped successful events.
check("verifier.verify(rawBody" in webhook and '"webhook-signature"' in webhook,
      "Dodo webhook signature must be verified over the raw body")
check('event.type === "payment.succeeded"' in webhook and
      'return json(res, 200, { received: true, processed: false });' in webhook,
      "Only successful payment events may grant purchases; unrelated events must be acknowledged without a grant")
check("No configured product mapping matched" in webhook,
      "Unmapped products must fail closed")
check("ON CONFLICT (provider, payment_id, product_id)" in webhook,
      "Repeated webhook deliveries must be idempotent")
check("payment_lifecycle" in webhook and "payment_lifecycle" in schema,
      "Payment lifecycle must protect against out-of-order refund/dispute events")
check("FROM payment_lifecycle AS lifecycle" in webhook and "Reconcile after inserts" in webhook,
      "Webhook must reconcile payment state after inserting entitlement records")
check('event.type === "refund.succeeded"' in webhook,
      "Successful refunds must be handled")
check('data.is_partial === true' in webhook,
      "Partial refunds must be distinguished from full refunds")
check('event.type === "dispute.opened"' in webhook and 'event.type === "dispute.lost"' in webhook,
      "Payment dispute lifecycle must be handled")
check("status_reason" in workspace and "status" in workspace,
      "Workspace must show whether purchase access is active, paused or revoked")
for env in (
    "DODO_PRODUCT_ID_WORKBOOK_19",
    "DODO_PRODUCT_ID_TOOLKIT_27",
    "DODO_PRODUCT_ID_ASSESSMENT_995",
    "DODO_PRODUCT_ID_AUDIT_9500",
):
    check(env in webhook and env in docs,
          f"Missing explicit payment product mapping: {env}")
check("bodyParser: false" in webhook,
      "Webhook body parsing must remain disabled so signature verification can use the raw payload")
check("MAX_WEBHOOK_BODY_BYTES = 1024 * 1024" in webhook and
      "rawBodyBytes > MAX_WEBHOOK_BODY_BYTES" in webhook and
      "return json(res, 413" in webhook,
      "Webhook must reject oversized payloads before buffering unbounded request bodies")

# Data minimization and truthful feature states.
check("owner_clerk_user_id TEXT" in schema and "owner_email TEXT" in schema,
      "Reports must have an explicit owner")
check("UNIQUE (provider, payment_id, product_id)" in schema,
      "Entitlement schema must prevent duplicate grants")
check("private_product_files" in schema and "blob_pathname TEXT NOT NULL UNIQUE" in schema,
      "Private product file metadata must be stored without public file URLs")
check("private_report_files" in schema and "REFERENCES workspace_reports(id) ON DELETE CASCADE" in schema,
      "Private report files must be linked to a specific report record")
check("f.owner_clerk_user_id = $2" in report_download and "r.owner_clerk_user_id = $2" in report_download,
      "A report file must be downloadable only by its assigned Clerk account")
check("e.product_id = f.product_id" in report_download and "e.status = 'active'" in report_download,
      "A report download must recheck the active paid entitlement at download time")
check("verifiedEmails.includes(email)" in report_publisher and "No active matching purchase entitlement" in report_publisher,
      "Paid report publishing must verify the owner's email and active product entitlement")
check("verifyToken" in download and "authorizedParties" in download,
      "Downloads must require a verified Clerk session from the production origin")
check("active" in download and "lower(entitlement.customer_email)" in download,
      "Downloads must require an active purchase for a verified email")
check('get(rows[0].blob_pathname' in download and 'access: "private"' in download,
      "Downloads must stream from private Blob storage rather than exposing a public URL")
check('Cache-Control' in download and 'no-store' in download,
      "Private downloads must not be cached")
check("BLOB_READ_WRITE_TOKEN" in download and 'WORKSPACE_ENABLED !== "true"' in download,
      "Download route must fail closed unless private storage and the workspace gate are configured")
check('access: "private"' in uploader and "knownProductIds.includes(productId)" in uploader,
      "Operator upload script must use private Blob and accept only explicitly mapped Dodo product IDs")
check("private_product_files" in uploader and "25 * 1024 * 1024" in uploader,
      "Product uploader must register file metadata and enforce the 25 MiB limit")
check("downloadsAvailable: storageConfigured && (purchases.some" in workspace,
      "Workspace must expose downloads only when private files are mapped for an active purchase")
check('"/api/download"' in ui and '"/api/report-download"' in ui and '"?fileId="' in ui,
      "Purchase UI must provide authenticated downloads without exposing private Blob URLs")
check('"svix"' in package and '"@clerk/backend"' in package and '"@neondatabase/serverless"' in package and '"@vercel/blob"' in package,
      "Required authentication, database, webhook and private storage packages must be declared")

# Rate limiting must protect sensitive routes without storing raw identifiers.
rate_limiter = read("api/_lib/rate-limit.js")
check("createHmac" in rate_limiter and 'digest("hex")' in rate_limiter,
      "Rate-limit identifiers must be HMAC hashed before persistence")
check("ON CONFLICT (key_hash, window_start) DO UPDATE" in rate_limiter,
      "Rate-limit counters must update atomically under concurrent requests")
check("RATE_LIMIT_HASH_SECRET" in rate_limiter and "length < 32" in rate_limiter,
      "Rate limiter must require a sufficiently long server-only HMAC secret")
check("LIMIT 100" in rate_limiter and "expires_at < now()" in rate_limiter,
      "Rate-limit cleanup must be bounded")
check("rate_limit_counters" in schema and "PRIMARY KEY (key_hash, window_start)" in schema,
      "Rate-limit schema must support atomic fixed-window counters")
for route in ("api/webhooks/dodo.js", "api/workspace.js", "api/assessment.js", "api/download.js", "api/report-download.js"):
    check("enforceRateLimit" in read(route), f"{route} must enforce rate limiting")
check("failClosed: true" in download and "failClosed: true" in report_download,
      "Protected downloads must fail closed if request protection is unavailable")
check("RATE_LIMIT_HASH_SECRET" in docs,
      "Setup guide must document the rate-limit HMAC secret")
check("const rateLimitConfigured = Boolean(" in config and "databaseConfigured &&" in config and
      "process.env.RATE_LIMIT_HASH_SECRET.length >= 32" in config and "rateLimitConfigured," in config,
      "Config endpoint must expose a non-sensitive rate-limit readiness boolean based on database and secret configuration")

if errors:
    print(f"FAIL: {len(errors)} of {checks} workspace security checks failed")
    for error in errors:
        print(" - " + error)
    sys.exit(1)
print(f"PASS: {checks} workspace security invariants")