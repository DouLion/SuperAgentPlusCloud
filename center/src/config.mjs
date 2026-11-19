// Center 配置读取（T10 重写）。
// 解析顺序：默认值 < 配置文件 < 环境变量（环境变量优先级最高，便于临时覆盖）。
// 只负责配置，不含业务逻辑；现有字段名 PORT/HOST/DB_PATH/WEB_DIST/config 保持可用。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DB_PATH } from './db/store.mjs';

/** center/ 目录，用于解析相对默认路径。 */
const CENTER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 配置文件默认文件名（相对 center 包目录）。 */
export const CONFIG_FILE_NAME = 'config.json';

/** 默认配置（同时作为配置文件的模板）。 */
export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  initialized: false,
  port: 8787,
  host: '127.0.0.1',
  db: Object.freeze({
    type: 'sqlite',
    path: 'center/data/center.db',
  }),
  llm: Object.freeze({
    base_url: '',
    api_key: '',
    model: 'deepseek-chat',
    timeout_ms: 30000,
  }),
});

/** 前端构建产物默认目录：center/../web/dist。 */
const DEFAULT_WEB_DIST = path.resolve(CENTER_DIR, '..', 'web', 'dist');

/** 配置文件绝对路径：SAP_CONFIG_PATH 优先，相对路径按 center 包目录解析。 */
export function configFilePath(env = process.env) {
  const raw = env.SAP_CONFIG_PATH || CONFIG_FILE_NAME;
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(CENTER_DIR, raw);
}

/** 归一化超时时间：非正数回退默认 30000。 */
function normalizeTimeout(value) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : 30000;
}

/** 归一化端口：非法值回退默认 8787。 */
function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_CONFIG.port;
}

/**
 * 解析数据库路径：绝对路径原样使用；相对路径按 center 包目录解析。
 * 兼容配置文件中形如 `center/data/center.db` 的写法（去掉开头的 center/）。
 */
function resolveDbPath(value) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_DB_PATH;
  if (path.isAbsolute(raw)) return path.normalize(raw);
  const rel = raw.replace(/^(?:center[\\/])+/, '');
  return path.resolve(CENTER_DIR, rel);
}

/** 深度合并 db / llm 之类的嵌套对象；overlay 优先。 */
function mergeConfig(base, overlay) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(overlay || {})) {
    if (value === undefined) continue;
    if (
      value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
      && out[key]
      && typeof out[key] === 'object'
      && !Array.isArray(out[key])
    ) {
      out[key] = { ...out[key], ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 读取配置文件。
 * 不存在返回 { exists:false, values:{} }；解析失败不抛崩，返回 { exists:true, values:{}, error }。
 */
export function readConfigFile(env = process.env) {
  const configPath = configFilePath(env);
  if (!fs.existsSync(configPath)) {
    return { exists: false, values: {}, path: configPath };
  }
  try {
    const text = fs.readFileSync(configPath, 'utf8');
    const values = JSON.parse(text);
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      return { exists: true, values: {}, error: '配置文件顶层必须是 JSON 对象', path: configPath };
    }
    return { exists: true, values, path: configPath };
  } catch (err) {
    return {
      exists: true,
      values: {},
      error: err instanceof Error ? err.message : String(err),
      path: configPath,
    };
  }
}

/**
 * 原子写配置文件：先写同目录临时文件，再 rename 覆盖。
 * 写入内容为「默认值 < 现有文件 < values」的合并结果，未传字段保留。
 * 返回绝对路径。
 */
export function writeConfigFile(values = {}, env = process.env) {
  const configPath = configFilePath(env);
  const existing = readConfigFile(env);
  const merged = mergeConfig(mergeConfig(DEFAULT_CONFIG, existing.values), values);
  merged.version = 1;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, configPath);
  return configPath;
}

/**
 * 合并三层配置，返回完整配置对象。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{version:number, initialized:boolean, port:number, host:string,
 *   db:{type:string, path:string}, llm:{base_url:string, api_key:string,
 *   model:string, timeout_ms:number}, web_dist:string, config_path:string,
 *   config_exists:boolean}}
 */
export function resolveConfig(env = process.env) {
  const file = readConfigFile(env);
  const merged = mergeConfig(DEFAULT_CONFIG, file.values);

  const port = normalizePort(env.CENTER_PORT || merged.port);
  const host = env.CENTER_HOST || merged.host || DEFAULT_CONFIG.host;
  const dbType = merged.db.type || DEFAULT_CONFIG.db.type;
  const dbPath = resolveDbPath(env.CENTER_DB || merged.db.path);
  const llm = {
    base_url: env.SAP_LLM_BASE_URL || merged.llm.base_url || '',
    api_key: env.SAP_LLM_API_KEY || merged.llm.api_key || '',
    model: env.SAP_LLM_MODEL || merged.llm.model || DEFAULT_CONFIG.llm.model,
    timeout_ms: normalizeTimeout(env.SAP_LLM_TIMEOUT_MS || merged.llm.timeout_ms),
  };
  const webDist = env.SAP_WEB_DIST || DEFAULT_WEB_DIST;

  return {
    version: Number.isInteger(merged.version) ? merged.version : DEFAULT_CONFIG.version,
    initialized: Boolean(merged.initialized),
    port,
    host,
    db: { type: dbType, path: dbPath },
    llm,
    web_dist: path.resolve(webDist),
    config_path: file.path,
    config_exists: file.exists,
  };
}

/** 读取模型配置；从 resolveConfig 的 llm 读取，环境变量仍可覆盖。 */
export function llmConfig(env = process.env) {
  return { ...resolveConfig(env).llm };
}

/** AI 功能是否可用：base_url 与 api_key 同时非空才为真。 */
export function aiConfigured(env = process.env) {
  const { base_url: baseUrl, api_key: apiKey } = llmConfig(env);
  return Boolean(baseUrl && apiKey);
}

/** 授权模式：optional（默认，无 token 走 legacy）/ required（写操作必须带 token）。 */
export const AUTH_MODES = ['optional', 'required'];

export function authMode(env = process.env) {
  const raw = String(env.SAP_AUTH_MODE || 'optional').toLowerCase();
  return AUTH_MODES.includes(raw) ? raw : 'optional';
}

// ── 兼容现有引用的快照（模块加载时求值）──────────────────────────────
const resolved = resolveConfig();

/** 前端构建产物目录，默认 center/../web/dist，可用 SAP_WEB_DIST 覆盖。 */
export const WEB_DIST = resolved.web_dist;

/** 监听端口，默认 8787。 */
export const PORT = resolved.port;

/** 监听地址，默认 127.0.0.1。 */
export const HOST = resolved.host;

/** 数据库文件路径，默认 center/data/center.db。 */
export const DB_PATH = resolved.db.path;

/**
 * 配置对象。llm 使用 getter，保证读取的是当前配置文件与环境变量。
 */
export const config = {
  port: resolved.port,
  host: resolved.host,
  db_path: resolved.db.path,
  web_dist: resolved.web_dist,
  initialized: resolved.initialized,
  db: resolved.db,
  config_path: resolved.config_path,
  get llm() {
    return llmConfig();
  },
};
