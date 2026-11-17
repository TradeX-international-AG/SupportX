-- "Bestellung erstatten" writes its own reply: the customer is told the refund is made right away.
ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_decision_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_decision_check CHECK (decision IN ('customer_right','customer_wrong','ask_customer','custom','invoice','refund'));
