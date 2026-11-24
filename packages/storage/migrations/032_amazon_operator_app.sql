-- Amazon access via the installation's own SP-API app ("Bei Amazon anmelden"):
-- the client ID and secret then live in the server's .env, the connection keeps
-- only the seller's refresh token (in secrets) and the seller ID from the consent.
ALTER TABLE amazon_listing_connections ADD COLUMN operator_app boolean NOT NULL DEFAULT false;
ALTER TABLE amazon_listing_connections ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE amazon_listing_connections ADD CONSTRAINT amazon_listing_connections_client CHECK (operator_app OR client_id IS NOT NULL);

-- A consent in progress: started by one owner, single use, valid 15 minutes.
CREATE TABLE amazon_oauth_states (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  region text NOT NULL CHECK (region IN ('eu', 'na', 'fe')),
  marketplace_ids text[] NOT NULL CHECK (cardinality(marketplace_ids) > 0),
  -- sha256 of the state values handed to Amazon (consent link, then the login step).
  state_hashes text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX amazon_oauth_states_user ON amazon_oauth_states (user_id, created_at);
