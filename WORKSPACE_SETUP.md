# Kartik Clarity Client Workspace — setup and release checklist

The public HTML site and free assessment remain public. The workspace is deliberately disabled until authentication and database settings exist. A deployment alone does **not** activate customer sign-in, reports, downloads, or purchase unlocks.

## Included in this branch

- `/workspace/`: setup-aware client workspace UI. It does not display a sign-in form until Clerk and PostgreSQL are configured.
- `/api/config`: exposes only public setup status and the Clerk publishable key (never the secret).
- `/api/workspace`: server-side verified Clerk token, verified email lookup, and per-user report/purchase queries.
- `/api/webhooks/dodo`: verifies the Svix-style Dodo webhook signature and only records `payment.succeeded` events for explicitly mapped product IDs.
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

The four product ID variables must contain actual product IDs from Dodo, not the public checkout URLs or the displayed prices. A product without a mapping never unlocks access. Leave unmapped products unset until verified.

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
10. Populate `workspace_reports` only through a trusted, access-controlled operator workflow after confirming the client's identity and scope. This branch intentionally does not invent reports or generate downloadable files. Secure file storage and protected download URLs must be implemented before downloads are offered.
11. Confirm Privacy Policy wording, data retention, deletion/support workflow, and your legal basis before putting real customer business information in the database.

## Important current limitations

- No production secrets or product IDs are included in this repository.
- Reports are read-only from the customer UI. Report authoring/upload is not implemented.
- Downloads are intentionally disabled; there is no public file URL.
- Payment entitlements are linked to the normalized purchase email and are visible only when it matches an email verified on the signed-in Clerk account. Purchases made with another email need a verified support process; do not manually bypass ownership checks.
- The webhook handles successful one-time payments for the four configured product IDs. Subscriptions, refunds, chargebacks, partial refunds, and entitlement revocation are not implemented. Do not sell subscription access on the basis of this handler.
- A webhook event may be accepted before all customer data is available; inspect Dodo's actual test payload before enabling production. Only the documented successful event and mapped product identifiers can create an entitlement.
- Configure rate limiting/abuse monitoring for auth and webhook endpoints before launch. The signature is verified, but operational monitoring and reconciliation remain necessary.
- This project is a static HTML site with Vercel Functions, not a Next.js application. Do not replace the public site with an unrelated application scaffold.

## Local smoke checks

- `GET /api/config` should return setup booleans without secret values.
- Before configuration or while `WORKSPACE_ENABLED` is not `true`, `GET /api/workspace` returns HTTP 503 and no sign-in form is shown.
- After Clerk and DB configuration, unauthenticated `GET /api/workspace` returns HTTP 401.
- An authenticated user gets only their own reports and entitlements matching their verified email addresses.
- Invalid Dodo signatures return HTTP 401; only a verified `payment.succeeded` event with a configured product ID may create an entitlement.
