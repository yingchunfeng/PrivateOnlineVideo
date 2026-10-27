-- 首次安装和密码登录的显式扩展。旧 users/auth_method 与 0001～0005 保持不变。
CREATE TABLE account_login_modes (
  owner_id TEXT PRIMARY KEY REFERENCES users(id),
  method TEXT NOT NULL CHECK(method IN ('password','totp','email')),
  updated_at TEXT NOT NULL
);
CREATE TABLE installation_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  stage TEXT NOT NULL CHECK(stage IN ('password','configuration','ready')),
  installation_code_hash TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  owner_id TEXT REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK((stage='password' AND owner_id IS NULL) OR (stage IN ('configuration','ready') AND owner_id IS NOT NULL))
);
CREATE TABLE installation_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  installation_version INTEGER NOT NULL CHECK(installation_version>0),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE installation_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  payload_cipher TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  updated_at TEXT NOT NULL
);
CREATE TABLE email_verification_challenges (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  login_session_id TEXT NOT NULL REFERENCES login_sessions(id),
  auth_version INTEGER NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  target_email TEXT NOT NULL,
  code_digest TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resend_at TEXT NOT NULL,
  error_count INTEGER NOT NULL DEFAULT 0 CHECK(error_count>=0),
  send_state TEXT NOT NULL DEFAULT 'pending' CHECK(send_state IN ('pending','sent','failed')),
  used_at TEXT,
  invalidated_at TEXT
);
CREATE INDEX email_verification_owner ON email_verification_challenges(owner_id,created_at);
CREATE INDEX email_verification_ip ON email_verification_challenges(ip_hash,created_at);
