-- Track when a subscriber last received a prompt, so a re-run of the sender
-- cannot mail the same person twice in a week, and so the founder can see who
-- has been reached without opening the database.
ALTER TABLE prompt_subscribers ADD COLUMN last_sent_at TEXT;
ALTER TABLE prompt_subscribers ADD COLUMN send_count INTEGER NOT NULL DEFAULT 0;
