// Center 设置服务（T10）。
// 负责首次初始化与后续配置更新、校验、以及「哪些字段需要重启才生效」的判断。
// 状态接口不回显 api_key 明文，只给 { configured }。

import {
  DEFAULT_CONFIG,
  configFilePath,
  readConfigFile,
  resolveConfig,
  writeConfigFile,
} from './config.mjs';

/** 构造带 code 的 400 校验错误。 */
function invalid(code, message) {
  const err = new Error(message);
  err.status = 400;
  err.code = code;
  return err;
}

/** 合并默认值与 overlay（db / llm 深层合并）。 */
function mergeValues(overlay) {
  const out = { ...DEFAULT_CONFIG };
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

/** 校验入参；不合法抛 400 + code。 */
function validate(values) {
  if (values.port !== undefined) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw invalid('INVALID_PORT', '端口必须是 1–65535 之间的整数');
    }
  }

  const db = values.db || {};
  // 允许保存三种类型，便于提前规划；运行时只放行已实现的方言（见 db/dialect.mjs）。
  if (db.type !== undefined && !['sqlite', 'postgres', 'postgresql', 'mysql'].includes(db.type)) {
    throw invalid('UNSUPPORTED_DB_TYPE', `未知的数据库类型 ${db.type}，可选 sqlite / postgres / mysql`);
  }
  if (db.path !== undefined && (typeof db.path !== 'string' || !db.path.trim())) {
    throw invalid('INVALID_DB_PATH', '数据库路径不能为空');
  }

  const llm = values.llm || {};
  if (llm.timeout_ms !== undefined) {
    const timeout = Number(llm.timeout_ms);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw invalid('INVALID_TIMEOUT', '模型超时时间必须是正数');
    }
  }

  const security = values.security || {};
  if (security.auth_mode !== undefined && !['optional', 'required'].includes(security.auth_mode)) {
    throw invalid('INVALID_AUTH_MODE', 'auth_mode 只能是 optional 或 required');
  }
  if (security.role_enforcement !== undefined && !['off', 'on'].includes(security.role_enforcement)) {
    throw invalid('INVALID_ROLE_ENFORCEMENT', 'role_enforcement 只能是 off 或 on');
  }
}

/** 把解析后的配置整理为对外状态（不含密钥明文）。 */
function toStatus(resolved) {
  const llm = resolved.llm;
  return {
    initialized: resolved.initialized,
    config_exists: resolved.config_exists,
    config_path: resolved.config_path,
    port: resolved.port,
    host: resolved.host,
    db_type: resolved.db.type,
    db_path: resolved.db.path,
    web_dist: resolved.web_dist,
    llm: {
      configured: Boolean(llm.base_url && llm.api_key),
      model: llm.model,
      base_url: llm.base_url,
    },
    security: {
      auth_mode: resolved.security.auth_mode,
      role_enforcement: resolved.security.role_enforcement,
    },
    needs_restart: [],
  };
}

/**
 * 读取当前设置状态。
 * @param {NodeJS.ProcessEnv} [env]
 */
export function setupStatus(env = process.env) {
  return toStatus(resolveConfig(env));
}

/**
 * 首次初始化：写入 initialized:true 与传入配置（未传的保留默认）。
 * @param {object} [values]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object} setupStatus
 */
export function initSetup(values = {}, env = process.env) {
  validate(values);
  const existing = readConfigFile(env);
  const merged = mergeValues(existing.values);
  const next = mergeValues({ ...merged, ...values, initialized: true });
  writeConfigFile(next, env);
  return setupStatus(env);
}

/**
 * 更新配置；返回 { status, needs_restart }。
 * needs_restart 含 port / host / db 这类需重启才生效的字段。
 * @param {object} [values]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function updateSetup(values = {}, env = process.env) {
  validate(values);
  const existing = readConfigFile(env);
  const before = mergeValues(existing.values);
  const next = mergeValues({ ...before, ...values });

  const needsRestart = [];
  if (next.port !== before.port) needsRestart.push('port');
  if (next.host !== before.host) needsRestart.push('host');
  if (next.db.type !== before.db.type || next.db.path !== before.db.path) {
    needsRestart.push('db');
  }

  writeConfigFile(next, env);
  return { status: setupStatus(env), needs_restart: needsRestart };
}

/** 供路由/测试使用的配置文件路径。 */
export { configFilePath };
