import { mkdir, copyFile } from "node:fs/promises";
await mkdir(new URL("../dist/db/migrations/", import.meta.url), { recursive: true });
for (const name of ["0001-initial.sql", "0002-library-organizing.sql", "0003-account-email.sql", "0004-smtp-config.sql", "0005-smtp-providers.sql"]) {
  await copyFile(new URL(`../src/db/migrations/${name}`, import.meta.url), new URL(`../dist/db/migrations/${name}`, import.meta.url));
}
