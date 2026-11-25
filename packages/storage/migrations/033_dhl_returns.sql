-- DHL Parcel DE Returns: return labels made from the case on a person's click.
-- Access per workspace: business customer portal user + password and the API key
-- (own key, or the key of the DHL tracking access) live encrypted in secrets as one
-- JSON value and are never returned. The receiver IDs (merchant's return addresses
-- per country) are kept here; the settings view shows only the country names.
CREATE TABLE dhl_return_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  secret_id uuid NOT NULL,
  -- true: no own API key, use the key of dhl_tracking_connections.
  use_tracking_key boolean NOT NULL DEFAULT false,
  -- alpha-3 country → receiver ID, e.g. {"DEU": "deu"}.
  receiver_ids jsonb NOT NULL,
  sandbox boolean NOT NULL DEFAULT false,
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

-- The label PDF is a case file of its own kind.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_source_check;
ALTER TABLE documents ADD CONSTRAINT documents_source_check CHECK (source IN ('library', 'upload', 'erp_invoice', 'return_label'));

-- Every label made at DHL, with the order and address it was made for.
CREATE TABLE return_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  carrier text NOT NULL DEFAULT 'dhl' CHECK (carrier IN ('dhl')),
  -- ERP order the address came from.
  order_id text,
  order_number text,
  shipment_no text NOT NULL,
  international_shipment_no text,
  routing_code text,
  country text NOT NULL,
  -- Address as sent to DHL (the customer's own, checked by the person).
  shipper jsonb NOT NULL,
  document_id uuid,
  sandbox boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, carrier, shipment_no),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, document_id) REFERENCES documents(workspace_id, id) ON DELETE SET NULL (document_id)
);
CREATE INDEX return_labels_case ON return_labels (workspace_id, conversation_id, created_at);
