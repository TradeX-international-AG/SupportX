-- "Datei anhängen" before a reply is written: the file waits with the case and goes
-- onto the next draft (whichever decision writes it). Cleared once it is on a draft.
ALTER TABLE documents ADD COLUMN for_next_reply boolean NOT NULL DEFAULT false;
