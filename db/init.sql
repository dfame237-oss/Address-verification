CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT,
  username TEXT UNIQUE,
  password_hash TEXT,
  mobile TEXT,
  email TEXT,
  business_name TEXT,
  business_type TEXT,
  plan_name TEXT,
  validity_end TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS support_messages (
  id TEXT PRIMARY KEY,
  client_id TEXT,
  name TEXT,
  email TEXT,
  mobile TEXT,
  message TEXT,
  created_at TEXT,
  resolved INTEGER DEFAULT 0,
  admin_reply TEXT
);

CREATE TABLE IF NOT EXISTS admin (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE,
  password_hash TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS usage_logs (
  id TEXT PRIMARY KEY,
  client_id TEXT,
  date TEXT,
  type TEXT,
  records_processed INTEGER
);
