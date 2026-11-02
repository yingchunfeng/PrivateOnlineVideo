CREATE TABLE site_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  default_theme TEXT NOT NULL CHECK(default_theme IN ('light', 'dark')),
  max_upload_bytes INTEGER NOT NULL CHECK(max_upload_bytes > 0),
  version INTEGER NOT NULL CHECK(version > 0),
  updated_at TEXT NOT NULL
);
