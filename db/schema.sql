-- Run this migration against the managed PostgreSQL database before enabling the workspace.
-- Report content is private business/customer data. Never place credentials or card data here.

CREATE TABLE IF NOT EXISTS workspace_reports (
  id BIGSERIAL PRIMARY KEY,
  owner_clerk_user_id TEXT,
  owner_email TEXT,
  title TEXT NOT NULL,
  report_type TEXT NOT NULL DEFAULT 'assessment',
  score NUMERIC(6,2),
  summary TEXT,
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
  action_plan JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workspace_reports_owner_check
    CHECK (owner_clerk_user_id IS NOT NULL OR owner_email IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS workspace_reports_owner_id_idx
  ON workspace_reports (owner_clerk_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workspace_reports_owner_email_idx
  ON workspace_reports (lower(owner_email), created_at DESC);

CREATE TABLE IF NOT EXISTS purchase_entitlements (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'dodo'),
  payment_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  entitlement_key TEXT NOT NULL,
  product_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, payment_id, product_id)
);

CREATE INDEX IF NOT EXISTS purchase_entitlements_email_idx
  ON purchase_entitlements (lower(customer_email), purchased_at DESC);

-- Reports can be inserted by a trusted operator/service after verifying client ownership.
-- Do not add a public report-upload endpoint without server-side authorization and validation.
