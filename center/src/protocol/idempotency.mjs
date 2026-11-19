// 命令账本（P3）：写操作的幂等键。
// 同 command_id + 同载荷摘要 → 返回首次结果；同键异摘要 → 409。

import crypto from 'node:crypto';
import { findActorByToken } from '../db/actors.mjs';
import { codedError, decodeJson, encodeJson, nowIso } from '../db/json.mjs';
import { bearerToken } from '../auth/policy.mjs';

export const COMMAND_ID_HEADER = 'x-sap-command-id';
export const REPLAY_HEADER = 'x-sap-idempotent-replay';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** 是否为需要幂等的写方法。 */
export function isWriteMethod(method) {
  return WRITE_METHODS.has(String(method || '').toUpperCase());
}

/** 稳定序列化：对象键排序，保证同载荷得到同摘要。 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

/** 载荷摘要：方法 + 路径 + 归一化后的 body。 */
export function payloadDigest(method, path, body) {
  const payload = JSON.stringify({
    method: String(method || '').toUpperCase(),
    path,
    body: body === undefined ? null : stable(body),
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/** 取命令 ID：请求头优先，其次 body.command_id。 */
export function commandId(req, body) {
  const header = req?.headers?.[COMMAND_ID_HEADER] ?? req?.headers?.['X-SAP-Command-Id'];
  if (header && String(header).trim()) return String(header).trim();
  const value = body?.command_id ?? body?.commandId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** 请求对应的主体 ID；无有效凭据时记为 legacy。 */
export function actorIdForRequest(db, req) {
  const token = bearerToken(req);
  if (!token) return 'legacy';
  const resolved = findActorByToken(db, token);
  return resolved?.actor?.actor_id ?? 'legacy';
}

/** 查询账本记录。 */
export function findCommand(db, commandIdValue) {
  return db.prepare('SELECT * FROM command_ledger WHERE command_id = ?').get(commandIdValue) ?? null;
}

/**
 * 预占命令 ID。已存在时返回 false，由调用方读取首条结果。
 * status_code 先写 0 表示「执行中」。
 */
export function reserveCommand(db, input) {
  const result = db.prepare(`INSERT OR IGNORE INTO command_ledger (
    command_id, actor_id, method, path, payload_digest, status_code,
    response_body, content_type, response_headers, created_at
  ) VALUES (?, ?, ?, ?, ?, 0, '', 'application/json; charset=utf-8', '{}', ?)`).run(
    input.command_id,
    input.actor_id ?? 'legacy',
    String(input.method).toUpperCase(),
    input.path,
    input.payload_digest,
    nowIso(),
  );
  return result.changes === 1;
}

/** 执行失败时释放预占，允许同键重试。 */
export function releaseCommand(db, commandIdValue) {
  db.prepare('DELETE FROM command_ledger WHERE command_id = ? AND status_code = 0').run(commandIdValue);
}

/** 记录最终结果。 */
export function finishCommand(db, input) {
  db.prepare(`UPDATE command_ledger SET status_code = ?, response_body = ?,
    content_type = ?, response_headers = ? WHERE command_id = ?`).run(
    input.status_code,
    input.response_body ?? '',
    input.content_type ?? 'application/json; charset=utf-8',
    encodeJson(input.response_headers ?? {}),
    input.command_id,
  );
}

/** 对外展示的命令结果。 */
export function commandResult(db, commandIdValue) {
  const row = findCommand(db, commandIdValue);
  if (!row) return null;
  return {
    command_id: row.command_id,
    actor_id: row.actor_id,
    method: row.method,
    path: row.path,
    status_code: row.status_code,
    response: decodeJson(row.response_body, row.response_body),
    content_type: row.content_type,
    created_at: row.created_at,
  };
}

/** 判定账本记录能否回放（已执行完成）。 */
export function isReplayable(row) {
  return Boolean(row) && Number(row.status_code) > 0;
}

/** 记录一次幂等回放（同键同摘要再次命中）。 */
export function recordReplay(db, commandIdValue) {
  db.prepare('UPDATE command_ledger SET replay_count = COALESCE(replay_count, 0) + 1 WHERE command_id = ?')
    .run(commandIdValue);
}

/** 冲突错误。 */
export function idempotencyConflict(commandIdValue) {
  return codedError(
    'IDEMPOTENCY_CONFLICT',
    `命令 ${commandIdValue} 已用不同载荷执行过`,
    409,
  );
}
