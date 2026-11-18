// Center 主干条目存储（T7 归置）。

import { appendEvent } from './events.mjs';
import { TRUNK_ITEM_KINDS, TRUNK_ITEM_STATUSES } from './enums.mjs';
import {
  camel,
  codedError,
  decodeJson,
  encodeJson,
  jsonField,
  newId,
  notFound,
  nowIso,
  pick,
  required,
} from './json.mjs';

const INSERT_TRUNK_ITEM = `INSERT INTO trunk_items (
  item_id, project_id, kind, statement, rationale, status, valid_from, valid_until,
  relations, source_refs, created_at, created_by, confirmed_at, confirmed_by,
  superseded_by
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function parseTrunkItem(row) {
  if (!row) return null;
  return {
    ...row,
    relations: decodeJson(row.relations, []),
    source_refs: decodeJson(row.source_refs, []),
  };
}

/**
 * 新建主干条目。item_id 缺省自动生成 `item_` 前缀 ID。
 * @returns {object} 已解析 JSON 字段的完整行
 */
export function createTrunkItem(db, input = {}) {
  const itemId = pick(input, 'item_id', 'itemId') ?? newId('item');
  const projectId = required(input, 'project_id', 'projectId');
  const kind = required(input, 'kind');
  const statement = required(input, 'statement');
  const status = pick(input, 'status') ?? 'proposed';

  if (!TRUNK_ITEM_KINDS.includes(kind)) {
    throw new Error(`非法的主干条目类型：${kind}`);
  }
  if (!TRUNK_ITEM_STATUSES.includes(status)) {
    throw new Error(`非法的主干条目状态：${status}`);
  }

  db.prepare(INSERT_TRUNK_ITEM).run(
    itemId,
    projectId,
    kind,
    statement,
    pick(input, 'rationale'),
    status,
    pick(input, 'valid_from', 'validFrom'),
    pick(input, 'valid_until', 'validUntil'),
    jsonField(input, 'relations'),
    jsonField(input, 'source_refs'),
    pick(input, 'created_at', 'createdAt') ?? nowIso(),
    pick(input, 'created_by', 'createdBy'),
    pick(input, 'confirmed_at', 'confirmedAt'),
    pick(input, 'confirmed_by', 'confirmedBy'),
    pick(input, 'superseded_by', 'supersededBy'),
  );
  return getTrunkItem(db, itemId);
}

/** 按 ID 查询主干条目；不存在返回 null。 */
export function getTrunkItem(db, itemId) {
  const row = db
    .prepare('SELECT * FROM trunk_items WHERE item_id = ?')
    .get(itemId);
  return parseTrunkItem(row);
}

/**
 * 列出主干条目，可按 project_id / status / kind 过滤。
 * @param {object} [query]
 */
export function listTrunkItems(db, query = {}) {
  const clauses = [];
  const params = [];

  const projectId = pick(query, 'project_id', 'projectId');
  if (projectId) {
    clauses.push('project_id = ?');
    params.push(projectId);
  }
  const status = pick(query, 'status');
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  const kind = pick(query, 'kind');
  if (kind) {
    clauses.push('kind = ?');
    params.push(kind);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT * FROM trunk_items ${where} ORDER BY created_at ASC, item_id ASC`,
    )
    .all(...params);
  return rows.map(parseTrunkItem);
}

const TRUNK_SCALAR_PATCH = {
  statement: 'statement',
  rationale: 'rationale',
  valid_from: 'valid_from',
  valid_until: 'valid_until',
  confirmed_at: 'confirmed_at',
  confirmed_by: 'confirmed_by',
  superseded_by: 'superseded_by',
};

const TRUNK_JSON_PATCH = {
  relations: 'relations',
  source_refs: 'source_refs',
};

/**
 * 更新主干条目状态，可附带更新确认信息、生效时间或被替代条目。
 * @param {object} [patch] 允许的附加字段
 * @returns {object|null} 更新后的完整行
 */
export function updateTrunkItemStatus(db, itemId, status, patch = {}) {
  if (!TRUNK_ITEM_STATUSES.includes(status)) {
    throw new Error(`非法的主干条目状态：${status}`);
  }
  const existing = getTrunkItem(db, itemId);
  if (!existing) throw new Error(`主干条目不存在：${itemId}`);

  const assignments = ['status = ?'];
  const params = [status];

  for (const [key, column] of Object.entries(TRUNK_SCALAR_PATCH)) {
    if (patch[key] !== undefined || patch[camel(key)] !== undefined) {
      assignments.push(`${column} = ?`);
      params.push(pick(patch, key, camel(key)));
    }
  }
  for (const [key, column] of Object.entries(TRUNK_JSON_PATCH)) {
    if (patch[key] !== undefined || patch[camel(key)] !== undefined) {
      assignments.push(`${column} = ?`);
      params.push(encodeJson(pick(patch, key, camel(key))));
    }
  }

  params.push(itemId);
  db.prepare(
    `UPDATE trunk_items SET ${assignments.join(', ')} WHERE item_id = ?`,
  ).run(...params);
  return getTrunkItem(db, itemId);
}

/**
 * 确认主干条目：仅 proposed 可确认 → active。
 * confirmed_by 必填；valid_from 可空（缺省保留原值）。写事件 trunk_item.confirmed。
 * 非 proposed 状态抛 code=INVALID_TRANSITION（409）。
 * @returns {object} 更新后的完整行
 */
export function confirmTrunkItem(db, itemId, patch = {}) {
  const item = getTrunkItem(db, itemId);
  if (!item) throw notFound(`主干条目不存在：${itemId}`);
  if (item.status !== 'proposed') {
    throw codedError('INVALID_TRANSITION', `主干条目当前状态不可确认：${item.status}`);
  }

  const confirmedBy = required(patch, 'confirmed_by', 'confirmedBy');
  const now = pick(patch, 'confirmed_at', 'confirmedAt') ?? nowIso();
  const validFrom = pick(patch, 'valid_from', 'validFrom') ?? item.valid_from ?? null;

  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE trunk_items
       SET status = 'active', confirmed_at = ?, confirmed_by = ?, valid_from = ?
       WHERE item_id = ?`,
    ).run(now, confirmedBy, validFrom, itemId);

    appendEvent(db, {
      project_id: item.project_id,
      object_type: 'trunk_item',
      object_id: itemId,
      event_type: 'trunk_item.confirmed',
      actor: confirmedBy,
      occurred_at: now,
      reason: validFrom
        ? `主干条目已确认生效，生效时间：${validFrom}`
        : '主干条目已确认生效',
      refs: [itemId],
    });

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return getTrunkItem(db, itemId);
}

/**
 * 退役主干条目：仅 active 可退役 → retired（停止生效，保留历史）。
 * confirmed_by 必填，作为退役操作人写入事件 trunk_item.retired；
 * 不覆盖原有的 confirmed_at / confirmed_by，避免抹掉首次确认痕迹。
 * 非 active 状态抛 code=INVALID_TRANSITION（409）。
 * @returns {object} 更新后的完整行
 */
export function retireTrunkItem(db, itemId, patch = {}) {
  const item = getTrunkItem(db, itemId);
  if (!item) throw notFound(`主干条目不存在：${itemId}`);
  if (item.status !== 'active') {
    throw codedError('INVALID_TRANSITION', `主干条目当前状态不可退役：${item.status}`);
  }

  const confirmedBy = required(patch, 'confirmed_by', 'confirmedBy');
  const now = pick(patch, 'confirmed_at', 'confirmedAt') ?? nowIso();

  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE trunk_items SET status = 'retired' WHERE item_id = ?`,
    ).run(itemId);

    appendEvent(db, {
      project_id: item.project_id,
      object_type: 'trunk_item',
      object_id: itemId,
      event_type: 'trunk_item.retired',
      actor: confirmedBy,
      occurred_at: now,
      reason: '主干条目已退役，停止生效并保留历史',
      refs: [itemId],
    });

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return getTrunkItem(db, itemId);
}
