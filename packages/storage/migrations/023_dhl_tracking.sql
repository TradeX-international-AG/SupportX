-- DHL Shipment Tracking (Unified API) of a workspace: read the carrier's own
-- parcel status into the case. The API key is encrypted in secrets and never
-- returned; only a masked hint is shown.
CREATE TABLE dhl_tracking_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  secret_id uuid NOT NULL,
  key_hint text NOT NULL,
  -- Test doubles only (ALLOW_TEST_ENDPOINTS).
  api_url text,
  status text NOT NULL DEFAULT 'configured',
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, secret_id) REFERENCES secrets(workspace_id, id)
);

-- Last answer of the carrier per parcel number and workspace (cache, so opening
-- a case does not spend the daily call limit again and again).
CREATE TABLE parcel_tracking (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  carrier text NOT NULL CHECK (carrier IN ('dhl')),
  tracking_number text NOT NULL,
  state text NOT NULL CHECK (state IN ('found', 'not_found', 'error')),
  status_code text,
  result jsonb NOT NULL,
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, carrier, tracking_number)
);
