-- Amazon SP-API website authorization: one pending consent per start, single use,
-- bound to the owner who started it and to the workspace it is for.
CREATE TABLE amazon_oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state_hash text NOT NULL UNIQUE,
  region text NOT NULL CHECK (region IN ('eu', 'na', 'fe')),
  marketplace_ids text[] NOT NULL CHECK (cardinality(marketplace_ids) > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX amazon_oauth_states_workspace ON amazon_oauth_states (workspace_id);
