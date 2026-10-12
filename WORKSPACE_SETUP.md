# Kartik Clarity Client Workspace — setup and release checklist

The public HTML site and free assessment remain public. The workspace is deliberately disabled until authentication and database settings exist. A deployment alone does **not** activate customer sign-in, reports, downloads, or purchase unlocks.

## Included in this branch

- `/workspace/`: setup-aware client workspace UI. It does not display a sign-in form until Clerk and PostgreSQL are configured.
- `/api/config`: exposes only public setup status and the Clerk publishable key (never the secret).
- `/api/workspace`: server-side verified Clerk token, verified email lookup, and per-user report/purchase queries.
- `/api/assessment`: optionally saves the public three-question directional preview after sign-in; the assessment itself remains usable without an account. The score and recommendations are derived server-side from the three allowed answer values.
- `/api/webhooks/dodo`: verifies signed Dodo webhook events, grants only explicitly mapped successful payments, and tracks full refunds and dispute lifecycle changes.
- `/db/schema.sql`: private report and purchase entitlement tables.

## Required Vercel environment variables

Set these on the **Kartik Clarity** Vercel project, not the separate Revenue Leak Detector project. Use Production and Preview scopes intentionally; don't commit secret values to GitHub.

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key for the browser sign-in component |
| `CLERK_SECRET_KEY` | Server-only Clerk key used to verify sessions and read verified emails |
| `WORKSPACE_ENABLED` | Explicit release gate; keep unset or `false` until the schema and smoke tests pass, then set to `true` |
| `DATABASE_URL` | PostgreSQL connection string from the managed database integration |
| `DODO_WEBHOOK_SECRET` | Signing secret for the Dodo webhook endpoint |
| `DODO_PRODUCT_ID_WORKBOOK_19` | Exact Dodo product ID for the $19 workbook |
| `DODO_PRODUCT_ID_TOOLKIT_27` | Exact Dodo product ID for the $27 toolkit |
| `DODO_PRODUCT_ID_ASSESSMENT_995` | Exact Dodo product ID for the $995 assessment |
| `DODO_PRODUCT_ID_AUDIT_9500` | Exact Dodo product ID for the $9,500 audit |

The four product ID variables must contain actual product IDs from Dodo, not the public checkout URLs or the displayed prices. A product without a mapping never unlocks access. Leave unmapped products unset until verified. The webhook uses idempotent inserts and a payment-level lifecycle row so a refund/dispute delivered before a success event cannot grant access later.

## Activation sequence

1. Create/connect a managed PostgreSQL database through the Vercel Marketplace (Neon is suitable) and add its `DATABASE_URL` to the intended Vercel environments.
2. Create a Clerk application. Configure email sign-in with email verification (email code or link), allow personal email addresses, and do not require an organization/work email. Add `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` to Vercel.
3. Run `db/schema.sql` against the database. Do not expose the connection string to browser code.
4. In Dodo, configure a webhook to `https://kartikclarity.vercel.app/api/webhooks/dodo` for the `payment.succeeded` event. Save the signing secret as `DODO_WEBHOOK_SECRET`.
5. Confirm each actual Dodo product ID and set its matching environment variable. Keep existing checkout links unchanged.
6. Redeploy after environment changes. Keep `WORKSPACE_ENABLED` unset/`false` while configuring. Use a test-mode product/payment and verify the webhook signature, recorded payment ID, exact email, and entitlement before enabling real product access.
7. Only after the schema is applied and the security smoke tests below pass, set `WORKSPACE_ENABLED=true` for the intended environment and redeploy.
8. Test sign-up, email verification, sign-in, sign-out, session expiry, a user with no reports, a report assigned to one user, and an attempted cross-user report access. Verify that an unverified email does not attach a purchase to the account.
9. Test the webhook with an invalid signature (must be rejected), an unsupported event (must not grant access), an unmapped product (must not grant access), and a repeated delivery (must not duplicate an entitlement).
10. Create the private Blob store and upload approved real product deliverables using the procedure in the Private product downloads section below. Populate `workspace_reports` only through a trusted, access-controlled operator workflow after confirming the client's identity and scope.
11. Confirm Privacy Policy wording, data retention, deletion/support workflow, and your legal basis before putting real customer business information in the database.

## Important current limitations

- No production secrets or product IDs are included in this repository.
- The signed-in user can save a directional preview of the public three-question assessment. This is not the full paid diagnostic. Personalized assessment/audit files can be published by a trusted operator script; there is no browser-based admin authoring dashboard.
- Protected downloads require configured private Blob storage, an applied schema migration, and uploaded real deliverables; they are not available until those dependencies are ready.
- Payment entitlements are linked to the normalized purchase email and are visible only when it matches an email verified on the signed-in Clerk account. Purchases made with another email need a verified support process; do not manually bypass ownership checks.
- The webhook handles successful one-time payments for the four configured product IDs. Full refunds revoke access; partial refunds retain access; open/challenged disputes pause access; lost/accepted/expired disputes revoke access; won/cancelled disputes can restore access only from the pending-review state. Subscriptions are not implemented. Confirm these business rules match your refund policy before launch.
- Inspect actual Dodo test payloads and event ordering before production. Only signed events with mapped product IDs can create entitlements; refunds and disputes change access state but never create a purchase.
- Configure rate limiting/abuse monitoring for auth and webhook endpoints before launch. The signature is verified, but operational monitoring and reconciliation remain necessary.
- This project is a static HTML site with Vercel Functions, not a Next.js application. Do not replace the public site with an unrelated application scaffold.

## Local smoke checks

- `GET /api/config` should return setup booleans without secret values.
- The homepage Save preview button appears only when the workspace release gate is enabled and all three preview questions have been answered; the free assessment remains public without login.
- `POST /api/assessment` requires a verified Clerk session, exactly three allowed answer values, and a UUID request ID; retries with the same request ID must not create duplicate preview reports.
- Before configuration or while `WORKSPACE_ENABLED` is not `true`, `GET /api/workspace` returns HTTP 503 and no sign-in form is shown.
- After Clerk and DB configuration, unauthenticated `GET /api/workspace` returns HTTP 401.
- An authenticated user gets only their own reports and entitlements matching their verified email addresses.
- Invalid Dodo signatures return HTTP 401; only a verified `payment.succeeded` event with a configured product ID may create an entitlement.


## Private product downloads

The protected download route uses Vercel Private Blob. It checks a valid Clerk session and a verified email against an active Dodo purchase entitlement before streaming a file; the underlying Blob pathname is never sent to the browser. Refund/review/revoked purchases do not receive download buttons, and the endpoint returns the same 404 for an unknown file and an unauthorized entitlement.

1. In the Vercel dashboard, create a **Private** Blob store attached only to the `kartikclarity` project. Do not attach it to the separate RevenueLeakDetector project.
2. Configure `BLOB_READ_WRITE_TOKEN` in the relevant environment. This is required by the download endpoint and the local upload script. Never commit the token.
3. Apply `db/schema.sql` again. The migration is additive and creates the private-file metadata table.
4. Confirm the product ID variables match the real Dodo product IDs in that environment. Use test-mode product IDs in Preview and live product IDs only in Production.
5. Upload an actual approved deliverable with `node scripts/upload_private_product.mjs <product-id> <file-path> [display-name]`. The local environment needs `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, and the matching `DODO_PRODUCT_ID_*` variable. Supported formats: PDF, ZIP, DOCX, XLSX; maximum 25 MiB. Do not upload placeholder content.
6. Test an entitled customer, a different signed-in account, an unverified email, a refunded/revoked entitlement, a review-state entitlement, a fake file ID, and an unauthenticated request. Only the active entitled customer should receive the file.

For a personalized paid assessment or audit, use `node scripts/publish_client_report.mjs <clerk-user-id> <verified-email> <title> <assessment|audit> <file-path> [summary]`. The script verifies the email on that Clerk account and checks for an active matching $995 assessment or $9,500 audit entitlement before publishing. The report record and its private file are tied to that Clerk user ID; product purchases cannot authorize access to another client's report.

A successful code deployment alone does not make the workspace customer-ready. Keep `WORKSPACE_ENABLED` unset or `false` until authentication, database migration, signed Dodo webhooks, product mapping, private storage, real product files, and the complete end-to-end checks have passed. This repository does not contain the actual paid deliverables.


## API abuse protection

Apply the updated `db/schema.sql` and configure `RATE_LIMIT_HASH_SECRET` as a random server-only secret of at least 32 characters in each environment where request limits should operate. Never commit its value. Identifiers are HMAC-SHA256 hashed before storage; raw IP addresses and Clerk user IDs are not persisted.

- Dodo webhook: 120 requests/minute/IP; limiter errors fail open so delivery is not dropped solely by the limiter.
- Workspace API: 30 requests/minute/IP; limiter errors fail open, while auth and database checks remain enforced.
- Assessment-save API: 20 requests/minute/IP; limiter errors fail open, while auth and validation remain enforced.
- Product and report downloads: 20 requests/minute/IP and 60 requests/10 minutes/verified Clerk user; limiter errors fail closed with HTTP 503.
- Exceeded limits return HTTP 429 with `Retry-After`. Expired-counter cleanup is bounded to 100 rows per cleanup run.

Keep `WORKSPACE_ENABLED` unset or `false` until the updated schema, rate limiter, authentication, payments, storage, and download smoke tests pass.
