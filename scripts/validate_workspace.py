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
check("lower(customer_email) IN (${emailPlaceholders})" in workspace and
      "[identity.userId, ...emails]" in workspace,
      "Report and purchase reads must use parameterized verified-email ownership filters")
check("`${index + 2}`" in workspace and "`${index + 1}`" in workspace,
      "SQL placeholder builders must emit PostgreSQL $N parameters, not bare numbers")
check("DO $" in schema and "$;" in schema,
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

# Data minimization and truthful feature states.
check("owner_clerk_user_id TEXT" in schema and "owner_email TEXT" in schema,
      "Reports must have an explicit owner")
check("UNIQUE (provider, payment_id, product_id)" in schema,
      "Entitlement schema must prevent duplicate grants")
check("downloadsAvailable: false" in workspace,
      "Downloads must remain disabled until protected storage exists")
check("downloadsAvailable" not in ui or "Download delivery will appear here only after secure file storage" in ui,
      "UI must not promise downloadable files before secure delivery exists")
check('"svix"' in package and '"@clerk/backend"' in package and '"@neondatabase/serverless"' in package,
      "Required authentication, database and webhook packages must be declared")

if errors:
    print(f"FAIL: {len(errors)} of {checks} workspace security checks failed")
    for error in errors:
        print(" - " + error)
    sys.exit(1)
print(f"PASS: {checks} workspace security invariants")
