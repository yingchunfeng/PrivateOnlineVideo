import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigurationError } from "./config.js";
import { guardDatabasePath, guardLocalFile, WORKSPACE_ROOT } from "../db/database.js";

export const DEFAULT_DEPLOYMENT_CONFIG = resolve(WORKSPACE_ROOT, "config/deployment.json");
export interface DeploymentTarget { databasePath: string; keyFile: string; reuseExistingKey: boolean }

export function parseDeploymentConfig(input: unknown): DeploymentTarget {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
    Object.keys(input).some(key => !["databasePath", "authKeyFile"].includes(key))) {
    throw new ConfigurationError("启动配置只允许 databasePath 和可选 authKeyFile；OSS/SMTP 请在网页保存到数据库");
  }
  const value = input as Record<string, unknown>;
  const validPath = (path: unknown): path is string => typeof path === "string" && path.trim().length > 0 && path === path.trim() && !path.includes("\0");
  if (!validPath(value.databasePath) || (value.authKeyFile !== undefined && !validPath(value.authKeyFile))) {
    throw new ConfigurationError("启动配置需要有效的 databasePath；authKeyFile 若提供必须是已有密钥文件的路径");
  }
  // npm workspace 的工作目录是 apps/api；配置中的相对路径始终以项目根目录为基准。
  const databasePath = guardDatabasePath(resolve(WORKSPACE_ROOT, value.databasePath));
  const keyFile = guardLocalFile(value.authKeyFile === undefined ? `${databasePath}.auth.key` : resolve(WORKSPACE_ROOT, value.authKeyFile as string));
  if (databasePath.toLowerCase() === keyFile.toLowerCase()) throw new ConfigurationError("数据库与加密主密钥不能使用同一路径");
  return { databasePath, keyFile, reuseExistingKey: value.authKeyFile !== undefined };
}

export function readDeploymentConfig(path = DEFAULT_DEPLOYMENT_CONFIG): DeploymentTarget {
  let input: unknown;
  try {
    const raw = readFileSync(resolve(WORKSPACE_ROOT, path), "utf8");
    if (Buffer.byteLength(raw) > 16_384) throw new Error("oversized deployment config");
    input = JSON.parse(raw);
  } catch { throw new ConfigurationError("无法读取启动配置；请检查 config/deployment.json 或 --config 指定的 UTF-8 JSON 文件，不会回退读取 .env"); }
  return parseDeploymentConfig(input);
}

export function readDeploymentTarget(args: readonly string[], defaultConfig = DEFAULT_DEPLOYMENT_CONFIG): DeploymentTarget {
  if (!args.length) return readDeploymentConfig(defaultConfig);
  if (args.length === 2 && args[0] === "--config" && args[1]) return readDeploymentConfig(args[1]);
  if (args[0] === "--database" && args[1] && (args.length === 2 || (args.length === 4 && args[2] === "--key-file" && args[3]))) {
    return parseDeploymentConfig({ databasePath: args[1], ...(args.length === 4 ? { authKeyFile: args[3] } : {}) });
  }
  throw new ConfigurationError("启动参数仅支持 --config <配置.json> 或 --database <数据库.db> [--key-file <已有.auth.key>]；无参数时读取 config/deployment.json");
}
