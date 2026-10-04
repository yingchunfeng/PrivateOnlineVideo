-- 只追加支持类型和多账号配置，保留 v4 的 smtp_config 原表及全部旧记录。
CREATE TABLE smtp_provider_types (
  code TEXT NOT NULL PRIMARY KEY CHECK(code IN ('qq','163')),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  email_domain TEXT NOT NULL UNIQUE,
  smtp_host TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  CHECK((code='qq' AND email_domain='qq.com' AND smtp_host='smtp.qq.com') OR
        (code='163' AND email_domain='163.com' AND smtp_host='smtp.163.com'))
);
INSERT INTO smtp_provider_types(code,name,email_domain,smtp_host) VALUES
  ('qq','QQ 邮箱','qq.com','smtp.qq.com'),
  ('163','163 邮箱','163.com','smtp.163.com');

CREATE TABLE smtp_provider_configs (
  provider_code TEXT NOT NULL PRIMARY KEY REFERENCES smtp_provider_types(code),
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  secure INTEGER NOT NULL CHECK(secure IN (0,1)),
  user TEXT NOT NULL CHECK(length(user)>0),
  password_cipher TEXT NOT NULL CHECK(length(password_cipher)>0),
  "from" TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL DEFAULT 15000 CHECK(timeout_ms BETWEEN 1 AND 60000),
  updated_at TEXT NOT NULL,
  CHECK((port=465 AND secure=1) OR (port=587 AND secure=0)),
  CHECK(instr(user,'@')>1),
  CHECK((provider_code='qq' AND host='smtp.qq.com' AND lower(substr(user,instr(user,'@')+1))='qq.com') OR
        (provider_code='163' AND host='smtp.163.com' AND lower(substr(user,instr(user,'@')+1))='163.com')),
  CHECK(lower("from")=lower(user))
);

-- 将匹配白名单的旧配置密文复制到相应类型；不覆盖或删除原配置。
INSERT INTO smtp_provider_configs(provider_code,host,port,secure,user,password_cipher,"from",timeout_ms,updated_at)
SELECT types.code,old.host,old.port,old.secure,lower(old.user),old.password_cipher,lower(old."from"),old.timeout_ms,old.updated_at
FROM smtp_config AS old JOIN smtp_provider_types AS types ON old.host=types.smtp_host
WHERE instr(old.user,'@')>1 AND lower(substr(old.user,instr(old.user,'@')+1))=types.email_domain AND lower(old."from")=lower(old.user)
  AND ((old.port=465 AND old.secure=1) OR (old.port=587 AND old.secure=0));
