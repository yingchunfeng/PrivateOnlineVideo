CREATE TABLE guests (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  permissions TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0)
);
CREATE INDEX guests_owner ON guests(owner_id);
CREATE TABLE guest_sessions (
  login_session_id TEXT PRIMARY KEY NOT NULL REFERENCES login_sessions(id),
  guest_id TEXT NOT NULL REFERENCES guests(id)
);
CREATE INDEX guest_sessions_guest ON guest_sessions(guest_id);
CREATE TABLE guest_uploads (
  upload_id TEXT PRIMARY KEY NOT NULL REFERENCES upload_tasks(id),
  guest_id TEXT NOT NULL REFERENCES guests(id)
);
CREATE INDEX guest_uploads_guest ON guest_uploads(guest_id);
