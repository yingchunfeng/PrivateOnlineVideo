import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LibraryConfig } from "@online-video/shared";
import { MAX_ORGANIZATION_LINKS } from "@online-video/shared";
import { WORKSPACE_ROOT } from "../db/database.js";
import { ConfigurationError } from "./config.js";
import { HttpError } from "./errors.js";
const unavailableConfigurations = new WeakSet<LibraryConfig>();
export function markLibraryUnavailable(config: LibraryConfig) { unavailableConfigurations.add(config); }
export function assertLibraryAvailable(config: LibraryConfig) { if (unavailableConfigurations.has(config)) throw new HttpError("CONFIG_RECOVERY_REQUIRED"); }

export function validateLibraryConfig(value: unknown): LibraryConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigurationError("视频库配置必须是JSON对象");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["mediaBaseUrl", "objectPrefix", "categories", "tagDefinitions"].includes(key)) ||
    input.mediaBaseUrl !== "https://oss.meetdawn.top" || input.objectPrefix !== "onlineVideo/" || !Array.isArray(input.categories)) {
    throw new ConfigurationError("视频库配置须使用固定媒体域名、onlineVideo/前缀及categories数组");
  }
  const definitions = input.tagDefinitions === undefined ? undefined : (() => {
    if (!Array.isArray(input.tagDefinitions)) throw new ConfigurationError("标签定义必须为数组");
    const ids = new Set<string>(); const names = new Set<string>();
    return input.tagDefinitions.map(value => {
      const tag = value as Record<string, unknown>;
      if (!tag || typeof tag !== "object" || Array.isArray(tag) || Object.keys(tag).some(key => !["id", "name", "enabled"].includes(key)) || typeof tag.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(tag.id) || ids.has(tag.id) || typeof tag.name !== "string" || !tag.name || tag.name !== tag.name.normalize("NFKC").trim() || tag.name.length > 100 || (tag.enabled !== undefined && typeof tag.enabled !== "boolean") || names.has(tag.name.toLocaleLowerCase("und"))) throw new ConfigurationError("标签定义ID、名称或启用状态不合法");
      ids.add(tag.id); names.add(tag.name.toLocaleLowerCase("und"));
      return { id: tag.id, name: tag.name, ...(tag.enabled === undefined ? {} : { enabled: tag.enabled }) };
    });
  })();
  const ids = new Set<string>(); const categoryNames = new Set<string>();
  const categories = input.categories.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigurationError("分类配置不合法");
    const item = value as Record<string, unknown>;
    if (Object.keys(item).some(key => !["id", "name", "tags", "tagIds", "enabled"].includes(key)) || typeof item.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.id) || ids.has(item.id) || typeof item.name !== "string" || !item.name.trim() ||
      item.name !== item.name.trim() || item.name.length > 100 || !Array.isArray(item.tags) ||
      (item.enabled !== undefined && typeof item.enabled !== "boolean")) throw new ConfigurationError("分类ID须稳定唯一，名称、标签或enabled配置不合法");
    const tagKeys = new Set<string>();
    for (const tag of item.tags) {
      if (typeof tag !== "string" || !tag.trim() || tag !== tag.normalize("NFKC").trim() || tag.length > 100) throw new ConfigurationError("标签必须是1至100字的规范名称");
      const tagKey = tag.toLocaleLowerCase("und");
      if (tagKeys.has(tagKey)) throw new ConfigurationError("同一分类不可重复配置标签");
      tagKeys.add(tagKey);
    }
    if (categoryNames.has(item.name.normalize("NFKC").toLocaleLowerCase("und"))) throw new ConfigurationError("分类名称不可重复");
    categoryNames.add(item.name.normalize("NFKC").toLocaleLowerCase("und"));
    if (item.tagIds !== undefined && (!Array.isArray(item.tagIds) || item.tagIds.length !== item.tags.length || new Set(item.tagIds).size !== item.tagIds.length || item.tagIds.some((id, index) => !definitions?.some(tag => tag.id === id && tag.name === (item.tags as string[])[index])))) throw new ConfigurationError("分类标签ID与名称不一致");
    ids.add(item.id);
    return { id: item.id, name: item.name, tags: [...item.tags] as string[], ...(item.tagIds === undefined ? {} : { tagIds: [...item.tagIds] as string[] }), ...(item.enabled === undefined ? {} : { enabled: item.enabled }) };
  });
  return { mediaBaseUrl: input.mediaBaseUrl, objectPrefix: input.objectPrefix, categories, ...(definitions === undefined ? {} : { tagDefinitions: definitions }) };
}

export function loadLibraryConfig(path = resolve(WORKSPACE_ROOT, "config/library.json")): LibraryConfig {
  try { return validateLibraryConfig(JSON.parse(readFileSync(path, "utf8"))); }
  catch (error) { if (error instanceof ConfigurationError) throw error; throw new ConfigurationError("无法读取视频库JSON配置，请检查config/library.json"); }
}

export function assertLibrarySelection(config: LibraryConfig, input: { categoryId?: unknown; tags?: unknown }): { categoryId: string; tags: string[] } {
  assertLibraryAvailable(config);
  const category = config.categories.find(item => item.id === input.categoryId);
  if (!category) throw new HttpError("NOT_FOUND");
  if (category.enabled === false) throw new HttpError("ORGANIZATION_CONFLICT");
  const tags = input.tags === undefined ? [] : input.tags;
  if (!Array.isArray(tags) || tags.length > MAX_ORGANIZATION_LINKS || tags.some(tag => typeof tag !== "string" || !category.tags.includes(tag) || config.tagDefinitions?.some(definition => definition.name === tag && definition.enabled === false)) || new Set(tags).size !== tags.length) throw new HttpError("VALIDATION_ERROR");
  return { categoryId: category.id, tags: [...tags] as string[] };
}

function validKey(config: LibraryConfig, key: string, requirePrefix = true) {
  if (typeof key !== "string" || !key || (requirePrefix && (!key.startsWith(config.objectPrefix) || key === config.objectPrefix)) || key.length > 1024 ||
    /[\\%?#\x00-\x1f\x7f]/.test(key) || key.split("/").some(part => !part || part === "." || part === "..")) throw new HttpError("VALIDATION_ERROR");
  return key;
}
export function publicUrlFor(config: LibraryConfig, key: string): string {
  return `${config.mediaBaseUrl}/${validKey(config, key, false).split("/").map(encodeURIComponent).join("/")}`;
}
export function objectKeyFromPublicUrl(config: LibraryConfig, value: unknown): string {
  if (typeof value !== "string" || !value.startsWith(`${config.mediaBaseUrl}/`) || /[?#]/.test(value)) throw new HttpError("VALIDATION_ERROR");
  let key: string;
  try {
    const url = new URL(value);
    if (url.origin !== config.mediaBaseUrl || url.username || url.password || url.search || url.hash) throw new Error("origin");
    key = decodeURIComponent(value.slice(config.mediaBaseUrl.length + 1));
  } catch { throw new HttpError("VALIDATION_ERROR"); }
  return validKey(config, key);
}
