import { mkdir, copyFile } from "node:fs/promises";
await mkdir(new URL("../dist/db/migrations/", import.meta.url), { recursive: true });
await copyFile(new URL("../src/db/migrations/0001-initial.sql", import.meta.url), new URL("../dist/db/migrations/0001-initial.sql", import.meta.url));
