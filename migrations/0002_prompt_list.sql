-- One-prompt-a-week list for blog readers who are not ready to sign up.
-- Captured on the article pages; no account, no password, one email a week.
-- The token is the unsubscribe handle and is never reused as an identifier.
CREATE TABLE IF NOT EXISTS prompt_subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  source TEXT,
  token TEXT NOT NULL UNIQUE,
  unsubscribed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_prompt_subscribers_token ON prompt_subscribers(token);
