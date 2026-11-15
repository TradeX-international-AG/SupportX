-- Credit note drafts in the ERP (weclapp) from a case. Off until the owner switches it on.
ALTER TABLE erp_connections ADD COLUMN credit_notes_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE erp_credit_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  invoice_id text NOT NULL,
  invoice_number text,
  currency text,
  total_cents integer NOT NULL CHECK (total_cents > 0),
  shipping_cents integer NOT NULL DEFAULT 0,
  -- [{itemId, title, grossCents}]
  lines jsonb NOT NULL,
  -- pending: being created; created: draft in the ERP with the amounts;
  -- needs_review: draft created but the amounts could not be set (fix in the ERP);
  -- uncertain: no answer while creating, check the ERP; failed: nothing created;
  -- dismissed: uncertain, a person checked the ERP and found none.
  state text NOT NULL CHECK (state IN ('pending', 'created', 'needs_review', 'uncertain', 'failed', 'dismissed')),
  credit_note_id text,
  credit_note_number text,
  result_cents integer,
  error text,
  requested_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX erp_credit_notes_case ON erp_credit_notes (workspace_id, conversation_id, created_at);
-- One open draft request per invoice: a double click cannot create two drafts.
CREATE UNIQUE INDEX erp_credit_notes_one_open ON erp_credit_notes (workspace_id, invoice_id) WHERE state IN ('pending', 'uncertain');
