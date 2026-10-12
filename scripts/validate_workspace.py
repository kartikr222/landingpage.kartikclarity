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
check("publishableKey: workspaceReady ? publishableKey : null" in config,
      "Only the publishable Clerk key may be returned to the browser")
check("CLERK_SECRET_KEY" in docs and "DODO_WEBHOOK_SECRET" in docs,
      "Setup guide must document server-side secret provisioning")

# Identity and data isolation.
check("verifyToken" in workspace and "req.headers.authorization" in workspace,
      "Private API must verify a bearer session token")
check('entry.verification.status === "verified"' in workspace,
      "Only verified email addresses may associate purchases/reports")
check("owner_clerk_user_id = ${identity.userId}" in workspace,
      "Report reads must be scoped to the authenticated Clerk user")
check("owner_clerk_user_id IS NULL" in workspace,
      "Legacy email ownership must not override a report's explicit user owner")
check("lower(customer_email) = ANY(${emails}::text[])" in workspace,
      "Purchases must be limited to verified account email addresses")
check('meta name="robots" content="noindex,nofollow"' in ui,
      "Workspace UI must be excluded from search indexing")

# Payment fulfillment is only based on signed, mapped successful events.
check("verifier.verify(rawBody" in webhook and '"webhook-signature"' in webhook,
      "Dodo webhook signature must be verified over the raw body")
check('event.type !== "payment.succeeded"' in webhook,
      "Non-success events must not grant purchases")
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
