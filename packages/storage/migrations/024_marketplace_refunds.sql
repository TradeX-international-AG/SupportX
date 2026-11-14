-- Refunds triggered at a marketplace from a case (first: Amazon order adjustment).
-- Off until the owner switches it on for the workspace's Amazon access.
ALTER TABLE amazon_listing_connections ADD COLUMN refunds_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE marketplace_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('amazon')),
  marketplace_id text NOT NULL,
  order_id text NOT NULL,
  reason text NOT NULL,
  currency text NOT NULL,
  total_cents integer NOT NULL CHECK (total_cents > 0),
  -- [{orderItemId, title, principalCents, shippingCents}]
  lines jsonb NOT NULL,
  -- pending: being sent; submitted: Amazon took the feed, result open;
  -- accepted: Amazon processed it without error; rejected: Amazon refused;
  -- uncertain: no answer while sending, check in Seller Central before anything else;
  -- failed: not sent; dismissed: uncertain, a person checked Seller Central and found no refund.
  state text NOT NULL CHECK (state IN ('pending', 'submitted', 'accepted', 'rejected', 'uncertain', 'failed', 'dismissed')),
  feed_id text,
  result_messages jsonb NOT NULL DEFAULT '[]',
  error text,
  requested_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  finished_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX marketplace_refunds_case ON marketplace_refunds (workspace_id, conversation_id, created_at);
CREATE INDEX marketplace_refunds_order ON marketplace_refunds (workspace_id, platform, order_id);
-- One open refund per order: a double click or a second person cannot refund twice
-- while the first is on its way, unanswered or unclear.
CREATE UNIQUE INDEX marketplace_refunds_one_open ON marketplace_refunds (workspace_id, platform, order_id) WHERE state IN ('pending', 'submitted', 'uncertain');
