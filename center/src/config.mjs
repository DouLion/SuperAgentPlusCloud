// Center 环境变量集中读取（T7 归置）。
// 只负责配置，不含业务逻辑；默认值与原有启动入口保持一致。

import path from 'node:path';
import { DEFAULT_DB_PATH } from './db/store.mjs';

/** 监听端口，默认 8787。 */
export const PORT = Number(process.env.CENTER_PORT || 8787);

/** 监听地址，默认 127.0.0.1。 */
export const HOST = process.env.CENTER_HOST || '127.0.0.1';

/** 数据库文件路径，默认 center/data/center.db。 */
export const DB_PATH = path.resolve(process.env.CENTER_DB || DEFAULT_DB_PATH);
