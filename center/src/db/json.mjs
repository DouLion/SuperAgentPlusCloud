// Center JSON 与通用工具（T7 归置）。
// 集中处理 JSON 编解码、字段挑选、必填校验、错误构造与 ID/时间生成。

import crypto from 'node:crypto';

/** 生成带前缀的全局唯一 ID。 */
export function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

/** 当前时间的 ISO 8601 字符串。 */
export function nowIso() {
  return new Date().toISOString();
}

/** 蛇形命名转驼峰，用于兼容 snake_case / camelCase 入参。 */
export function camel(snake) {
  return snake.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
}

/** JSON 编码为 TEXT；null / undefined 存 NULL。 */
export function encodeJson(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

/** JSON 解码；空值或非法文本回退到 fallback。 */
export function decodeJson(text, fallback = null) {
  if (text === undefined || text === null || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 依次尝试多个键名，返回第一个非空值（兼容 snake_case / camelCase）。 */
export function pick(source, ...keys) {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

/** 取必填字段；缺失时抛出带中文说明的错误。 */
export function required(source, ...keys) {
  const value = pick(source, ...keys);
  if (value === undefined) throw new Error(`缺少必填字段：${keys[0]}`);
  return value;
}

/** 取 JSON 字段并编码；未给出时用 fallback。 */
export function jsonField(source, key, fallback = []) {
  const value = pick(source, key, camel(key));
  return encodeJson(value === undefined ? fallback : value);
}

/** 构造带 code / status 的可识别错误，便于 HTTP 层映射。 */
export function codedError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

/** 构造 404 错误。 */
export function notFound(message) {
  return Object.assign(new Error(message), { status: 404 });
}
