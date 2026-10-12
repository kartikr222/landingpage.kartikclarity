-- Run this migration against managed PostgreSQL before enabling the workspace.
-- Report content is private business/customer data. Never store credentials or card data.

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
  source_request_id TEXT,
  CONSTRAINT workspace_reports_owner_check
    CHECK (owner_clerk_user_id IS NOT NULL OR owner_email IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS workspace_reports_owner_id_idx
  ON workspace_reports (owner_clerk_user_id, created_at DESC);
ALTER TABLE workspace_reports
  ADD COLUMN IF NOT EXISTS source_request_id TEXT;

CREATE INDEX IF NOT EXISTS workspace_reports_owner_email_idx
  ON workspace_reports (lower(owner_email), created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_reports_request_id_idx
  ON workspace_reports (owner_clerk_user_id, source_request_id)
  WHERE source_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS purchase_entitlements (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'dodo'),
  payment_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  entitlement_key TEXT NOT NULL,
  product_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'review', 'revoked')),
  status_reason TEXT,
  status_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, payment_id, product_id)
);

-- Safe additive migration if this script is run against an earlier draft schema.
ALTER TABLE purchase_entitlements
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE purchase_entitlements
  ADD COLUMN IF NOT EXISTS status_reason TEXT;
ALTER TABLE purchase_entitlements
  ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS purchase_entitlements_email_idx
  ON purchase_entitlements (lower(customer_email), purchased_at DESC);
CREATE INDEX IF NOT EXISTS purchase_entitlements_status_idx
  ON purchase_entitlements (status, purchased_at DESC);

-- Payment-level state protects against duplicate and out-of-order webhook delivery.
-- A refund/dispute delivered before payment.succeeded must never result in a grant.
CREATE TABLE IF NOT EXISTS payment_lifecycle (
  provider TEXT NOT NULL CHECK (provider = 'dodo'),
  payment_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'review', 'revoked')),
  status_reason TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, payment_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'purchase_entitlements_status_check'
  ) THEN
    ALTER TABLE purchase_entitlements
      ADD CONSTRAINT purchase_entitlements_status_check
      CHECK (status IN ('active', 'review', 'revoked'));
  END IF;
END
$$;

-- Reports can be inserted only by a trusted, access-controlled operator/service
-- after verifying client ownership. No public report-upload endpoint is provided.


-- Private product deliverables live in a private Vercel Blob store.
-- Only metadata is stored here; customer downloads must pass the entitlement check
-- in api/download.js before the server streams a private blob.
CREATE TABLE IF NOT EXISTS private_product_files (
  id BIGSERIAL PRIMARY KEY,
  product_id TEXT NOT NULL,
  blob_pathname TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (
    content_type IN (
      'application/pdf',
      'application/zip',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
  ),
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS private_product_files_active_name_idx
  ON private_product_files (product_id, file_name) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS private_product_files_product_idx
  ON private_product_files (product_id, active);


-- Private product deliverables live in a private Vercel Blob store.
-- Only metadata is stored here; customer downloads must pass the entitlement check
-- in api/download.js before the server streams a private blob.
CREATE TABLE IF NOT EXISTS private_product_files (
  id BIGSERIAL PRIMARY KEY,
  product_id TEXT NOT NULL,
  blob_pathname TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (
    content_type IN (
      'application/pdf',
      'application/zip',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
  ),
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS private_product_files_active_name_idx
  ON private_product_files (product_id, file_name) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS private_product_files_product_idx
  ON private_product_files (product_id, active);


-- Client-specific report files are separate from product downloads. A purchase
-- for one product must never authorize access to another client's report.
CREATE TABLE IF NOT EXISTS private_report_files (
  id BIGSERIAL PRIMARY KEY,
  report_id BIGINT NOT NULL REFERENCES workspace_reports(id) ON DELETE CASCADE,
  owner_clerk_user_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  blob_pathname TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (
    content_type IN (
      'application/pdf',
      'application/zip',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
  ),
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS private_report_files_active_name_idx
  ON private_report_files (report_id, file_name) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS private_report_files_owner_idx
  ON private_report_files (owner_clerk_user_id, active);

CREATE INDEX IF NOT EXISTS private_report_files_product_idx
  ON private_report_files (product_id, active);
