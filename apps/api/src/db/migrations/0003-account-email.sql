-- 只追加账号邮件认证状态，保留账号、TOTP、恢复码及业务关联。
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
ALTER TABLE users ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'totp' CHECK(auth_method IN ('totp','email'));
ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1 CHECK(auth_version>0);
ALTER TABLE login_sessions ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1 CHECK(auth_version>0);
CREATE TRIGGER users_email_auth_insert BEFORE INSERT ON users
WHEN NEW.auth_method='email' AND (NEW.email IS NULL OR length(trim(NEW.email))=0 OR NEW.email_verified_at IS NULL)
BEGIN SELECT RAISE(ABORT,'verified email required'); END;
CREATE TRIGGER users_email_auth_update BEFORE UPDATE OF auth_method,email,email_verified_at ON users
WHEN NEW.auth_method='email' AND (NEW.email IS NULL OR length(trim(NEW.email))=0 OR NEW.email_verified_at IS NULL)
BEGIN SELECT RAISE(ABORT,'verified email required'); END;
CREATE TABLE account_operations (id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),login_session_id TEXT NOT NULL REFERENCES login_sessions(id),
  auth_version INTEGER NOT NULL,operation_type TEXT NOT NULL CHECK(operation_type IN ('bind_email','change_password','change_email')),target_email TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','old_verified','completed','cancelled','invalidated')),
  created_at TEXT NOT NULL,expires_at TEXT NOT NULL,old_verified_at TEXT,invalidated_at TEXT);
CREATE INDEX account_operations_owner ON account_operations(owner_id,state);
CREATE TABLE email_challenges (id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL CHECK(purpose IN ('login','bind_email','change_password','change_email_old','change_email_new')),target_email TEXT NOT NULL,
  auth_version INTEGER NOT NULL,operation_id TEXT REFERENCES account_operations(id),login_session_id TEXT REFERENCES login_sessions(id),code_digest TEXT NOT NULL,
  send_sequence INTEGER NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,resend_at TEXT NOT NULL,
  error_count INTEGER NOT NULL DEFAULT 0 CHECK(error_count>=0),send_state TEXT NOT NULL DEFAULT 'pending' CHECK(send_state IN ('pending','sent','failed')),
  used_at TEXT,invalidated_at TEXT);
CREATE INDEX email_challenges_scope ON email_challenges(owner_id,purpose,send_sequence);
CREATE TABLE email_send_limits(challenge_id TEXT PRIMARY KEY REFERENCES email_challenges(id),owner_id TEXT NOT NULL REFERENCES users(id),ip_hash TEXT NOT NULL,reserved_at INTEGER NOT NULL);
CREATE INDEX email_send_account ON email_send_limits(owner_id,reserved_at);
CREATE INDEX email_send_ip ON email_send_limits(ip_hash,reserved_at);
CREATE TABLE security_notifications(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),target_email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('password_changed','email_changed')),state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','failed')),
  created_at TEXT NOT NULL,completed_at TEXT);
