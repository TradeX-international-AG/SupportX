-- Phone hotline: a voice agent (e.g. ElevenLabs Agents on a SIP number) asks
-- SupportX during a call (order status, invoice) and reports the call afterwards.
-- The tool token is stored only as a hash; the webhook secret is encrypted in secrets.
CREATE TABLE voice_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'elevenlabs' CHECK (provider IN ('elevenlabs')),
  token_sha256 text NOT NULL UNIQUE,
  token_hint text NOT NULL,
  webhook_secret_id uuid,
  -- summary: the case keeps the agent's summary; transcript: also the spoken text. Never audio.
  transcript_mode text NOT NULL DEFAULT 'summary' CHECK (transcript_mode IN ('summary', 'transcript')),
  -- Where the agent hands over when it cannot help (shown in the setup guide; the agent config holds it).
  handover_number text,
  last_call_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, webhook_secret_id) REFERENCES secrets(workspace_id, id)
);

-- One row per call (the agent's conversation id). Holds the verified order of the call
-- so later tools need no second check, and the case the call became.
CREATE TABLE phone_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  call_ref text NOT NULL,
  caller_hint text,
  failed_checks int NOT NULL DEFAULT 0,
  last_check_at timestamptz,
  verified_order_id text,
  verified_order_number text,
  invoice_requested_at timestamptz,
  invoice_email text,
  conversation_id uuid,
  summary text,
  duration_sec int,
  reported_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, call_ref),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE SET NULL (conversation_id)
);
CREATE INDEX phone_calls_recent_failures ON phone_calls (workspace_id, last_check_at) WHERE failed_checks > 0;
