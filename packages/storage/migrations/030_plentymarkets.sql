-- plentymarkets as a second order system next to weclapp. One order system per workspace.
ALTER TABLE erp_connections DROP CONSTRAINT IF EXISTS erp_connections_provider_check;
ALTER TABLE erp_connections ADD CONSTRAINT erp_connections_provider_check CHECK (provider IN ('weclapp','plentymarkets'));
CREATE UNIQUE INDEX IF NOT EXISTS erp_connections_one_per_workspace ON erp_connections (workspace_id);
-- Non-secret login name (plentymarkets REST user); the password stays in secrets.
ALTER TABLE erp_connections ADD COLUMN IF NOT EXISTS username text;
