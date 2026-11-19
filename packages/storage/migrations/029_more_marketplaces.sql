-- 0.19.0 more marketplaces: OTTO (mail + order API) and the Mirakl marketplaces
-- Douglas, MediaMarkt/Saturn, Conrad and Decathlon next to Shop Apotheke.

ALTER TABLE merchant_accounts DROP CONSTRAINT merchant_accounts_platform_check;
ALTER TABLE merchant_accounts ADD CONSTRAINT merchant_accounts_platform_check
  CHECK (platform IN ('email','amazon','ebay','kaufland','otto','shop_apotheke','douglas','mediamarkt_saturn','conrad','decathlon','docmorris','shopify'));

-- Reply deadlines for the new platforms; values a workspace already set stay.
ALTER TABLE workspaces ALTER COLUMN reply_deadlines
  SET DEFAULT '{"amazon":24,"ebay":48,"kaufland":48,"otto":24,"shop_apotheke":48,"douglas":48,"mediamarkt_saturn":48,"conrad":48,"decathlon":48,"docmorris":48,"shopify":48,"email":48}';
UPDATE workspaces SET reply_deadlines = '{"otto":24,"douglas":48,"mediamarkt_saturn":48,"conrad":48,"decathlon":48}'::jsonb || reply_deadlines;

-- Read-only marketplace APIs that are not a message channel (today: OTTO order
-- status). One per platform and workspace; the key itself lives in secrets and
-- is shown only as a hint.
CREATE TABLE marketplace_api_connections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('otto')),
  secret_id uuid NOT NULL,
  key_hint text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'configured' CHECK (status IN ('configured','ok','error')),
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, platform),
  FOREIGN KEY (workspace_id, secret_id) REFERENCES secrets (workspace_id, id)
);
