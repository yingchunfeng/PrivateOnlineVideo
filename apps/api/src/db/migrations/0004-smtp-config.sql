-- 单条站点 SMTP 配置；授权码使用现有 auth.key 加密，迁移不写入真实凭证。
CREATE TABLE smtp_config (
  id INTEGER PRIMARY KEY CHECK(id=1),
  host TEXT NOT NULL CHECK(length(host)>0),
  port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
  secure INTEGER NOT NULL CHECK(secure IN (0,1)),
  user TEXT NOT NULL CHECK(length(user)>0),
  password_cipher TEXT NOT NULL CHECK(length(password_cipher)>0),
  "from" TEXT NOT NULL CHECK(length("from")>0),
  timeout_ms INTEGER NOT NULL DEFAULT 15000 CHECK(timeout_ms BETWEEN 1 AND 60000),
  updated_at TEXT NOT NULL
);
