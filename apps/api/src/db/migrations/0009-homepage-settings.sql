CREATE TABLE homepage_settings (
  owner_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  category_random_enabled INTEGER NOT NULL CHECK(category_random_enabled IN (0, 1)),
  video_order TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  updated_at TEXT NOT NULL
);
