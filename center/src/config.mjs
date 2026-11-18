// Center 环境变量集中读取（T7 归置，T8 增加模型接入配置）。
// 只负责配置，不含业务逻辑；默认值与原有启动入口保持一致。

import path from 'node:path';
import { DEFAULT_DB_PATH } from './db/store.mjs';

/** 监听端口，默认 8787。 */
export const PORT = Number(process.env.CENTER_PORT || 8787);

/** 监听地址，默认 127.0.0.1。 */
export const HOST = process.env.CENTER_HOST || '127.0.0.1';

/** 数据库文件路径，默认 center/data/center.db。 */
export const DB_PATH = path.resolve(process.env.CENTER_DB || DEFAULT_DB_PATH);

/** 读取模型配置；每次调用都读环境变量，便于测试与运行期覆盖。 */
export function llmConfig(env = process.env) {
  const timeout = Number(env.SAP_LLM_TIMEOUT_MS || 30000);
  return {
    base_url: env.SAP_LLM_BASE_URL || '',
    api_key: env.SAP_LLM_API_KEY || '',
    model: env.SAP_LLM_MODEL || 'deepseek-chat',
    timeout_ms: Number.isFinite(timeout) && timeout > 0 ? timeout : 30000,
  };
}

/** AI 功能是否可用：base_url 与 api_key 同时非空才为真。 */
export function aiConfigured(env = process.env) {
  const { base_url: baseUrl, api_key: apiKey } = llmConfig(env);
  return Boolean(baseUrl && apiKey);
}

/**
 * 配置对象。llm 使用 getter，保证读取的是当前环境变量。
 */
export const config = {
  port: PORT,
  host: HOST,
  db_path: DB_PATH,
  get llm() {
    return llmConfig();
  },
};
