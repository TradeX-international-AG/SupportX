-- A person forwards the whole case (all messages, our replies, the order from the
-- ERP, attachments) as one new mail. Such a forward has no single source message.
-- mode case: new mail through a connected mailbox, which may differ from the
-- case's own connection (marketplace API cases have no mailbox of their own).
ALTER TABLE message_forwards ALTER COLUMN message_id DROP NOT NULL;
ALTER TABLE message_forwards DROP CONSTRAINT message_forwards_mode_check;
ALTER TABLE message_forwards ADD CONSTRAINT message_forwards_mode_check CHECK (mode IN ('original','text','case'));
ALTER TABLE message_forwards ADD CONSTRAINT message_forwards_source_check CHECK ((mode = 'case') = (message_id IS NULL));
