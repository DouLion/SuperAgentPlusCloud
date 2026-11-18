// 项目约定包（T12）：团队模板与项目快照的版本化存储。

import { appendEvent } from './events.mjs';
import { appendDefinitionEvent } from './definition-events.mjs';
import { assertProjectExists } from './projects.mjs';
import {
  CONVENTION_PACK_SCOPES,
  CONVENTION_RULE_SEVERITIES,
  VERSIONED_DEFINITION_STATUSES,
} from './enums.mjs';
import {
  codedError,
  decodeJson,
  encodeJson,
  newId,
  nowIso,
  pick,
  required,
} from './json.mjs';

const INSERT_PACK = `INSERT INTO convention_packs (
  pack_id, name, description, status, version, scope, project_id, rules,
  created_by, created_at, activated_at, supersedes, imported_from
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function parsePack(row) {
  if (!row) return null;
  return { ...row, rules: decodeJson(row.rules, []) };
}

function normalizeRules(value) {
  if (!Array.isArray(value)) throw new Error('rules 必须是数组');
  const keys = new Set();
  return value.map((rule, index) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error(`第 ${index + 1} 条规则必须是对象`);
    }
    const key = required(rule, 'key').trim();
    if (!key) throw new Error(`第 ${index + 1} 条规则的 key 不能为空`);
    if (keys.has(key)) throw new Error(`规则 key 重复：${key}`);
    keys.add(key);
    const title = required(rule, 'title').trim();
    const severity = pick(rule, 'severity') ?? 'should';
    if (!CONVENTION_RULE_SEVERITIES.includes(severity)) {
      throw new Error(`非法的规则严重程度：${severity}`);
    }
    if (!title) throw new Error(`第 ${index + 1} 条规则的 title 不能为空`);
    return {
      key,
      category: pick(rule, 'category') ?? 'other',
      title,
      severity,
      value: rule.value ?? null,
      rationale: pick(rule, 'rationale') ?? '',
      examples: Array.isArray(rule.examples) ? rule.examples : [],
    };
  });
}

export function createConventionPack(db, input = {}) {
  const packId = pick(input, 'pack_id', 'packId') ?? newId('pack');
  const name = required(input, 'name');
  const scope = required(input, 'scope');
  if (!CONVENTION_PACK_SCOPES.includes(scope)) throw new Error(`非法的约定包作用域：${scope}`);
  const status = pick(input, 'status') ?? 'draft';
  if (!VERSIONED_DEFINITION_STATUSES.includes(status)) throw new Error(`非法的约定包状态：${status}`);
  const projectId = pick(input, 'project_id', 'projectId');
  if (scope === 'project') {
    if (!projectId) throw new Error('项目约定包必须提供 project_id');
    assertProjectExists(db, projectId);
  } else if (projectId) {
    throw new Error('团队模板不能绑定 project_id');
  }
  if (status !== 'draft') throw new Error('新建约定包只能是 draft 状态');
  const version = Number(pick(input, 'version') ?? 1);
  if (!Number.isInteger(version) || version < 1) throw new Error('version 必须是正整数');
  const rules = normalizeRules(pick(input, 'rules') ?? []);
  const createdBy = required(input, 'created_by', 'createdBy');
  const now = pick(input, 'created_at', 'createdAt') ?? nowIso();
  const supersedes = pick(input, 'supersedes');
  const importedFrom = pick(input, 'imported_from', 'importedFrom');

  db.prepare(INSERT_PACK).run(
    packId, name, pick(input, 'description'), status, version, scope, projectId,
    encodeJson(rules), createdBy, now, null, supersedes, importedFrom,
  );
  appendDefinitionEvent(db, {
    project_id: projectId,
    object_type: 'convention_pack', object_id: packId,
    event_type: 'convention_pack.created', actor: createdBy,
    occurred_at: now, reason: `创建约定包：${name}`,
    refs: importedFrom ? [importedFrom] : [],
  });
  if (projectId) {
    appendEvent(db, {
      project_id: projectId,
      object_type: 'convention_pack',
      object_id: packId,
      event_type: 'convention_pack.created',
      actor: createdBy,
      occurred_at: now,
      reason: name,
      refs: importedFrom ? [importedFrom] : [],
    });
  }
  return getConventionPack(db, packId);
}

export function getConventionPack(db, packId) {
  return parsePack(db.prepare('SELECT * FROM convention_packs WHERE pack_id = ?').get(packId));
}

export function listConventionPacks(db, query = {}) {
  const clauses = [];
  const params = [];
  for (const [key, column] of [
    ['scope', 'scope'], ['project_id', 'project_id'], ['status', 'status'], ['name', 'name'],
  ]) {
    const value = pick(query, key, key === 'project_id' ? 'projectId' : key);
    if (value !== undefined) {
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM convention_packs ${where} ORDER BY created_at DESC, pack_id DESC`)
    .all(...params).map(parsePack);
}

export function activateConventionPack(db, packId, patch = {}) {
  const pack = getConventionPack(db, packId);
  if (!pack) throw Object.assign(new Error(`约定包不存在：${packId}`), { status: 404 });
  if (pack.status !== 'draft') {
    throw codedError('INVALID_TRANSITION', `约定包当前状态不可激活：${pack.status}`, 409);
  }
  if (!pack.rules.length) throw new Error('空约定包不能激活');
  const actor = required(patch, 'activated_by', 'activatedBy');
  const now = nowIso();
  db.exec('BEGIN');
  try {
    // 同一项目（或同名团队模板）只保留一个 active 版本。
    const active = pack.scope === 'project'
      ? db.prepare("SELECT pack_id FROM convention_packs WHERE project_id = ? AND status = 'active'").all(pack.project_id)
      : db.prepare("SELECT pack_id FROM convention_packs WHERE scope = 'team' AND name = ? AND status = 'active'").all(pack.name);
    for (const row of active) {
      db.prepare("UPDATE convention_packs SET status = 'superseded' WHERE pack_id = ?").run(row.pack_id);
    }
    db.prepare("UPDATE convention_packs SET status = 'active', activated_at = ? WHERE pack_id = ?")
      .run(now, packId);
    const reason = required(patch, 'reason');
    appendDefinitionEvent(db, {
      project_id: pack.project_id,
      object_type: 'convention_pack', object_id: packId,
      event_type: 'convention_pack.activated', actor, occurred_at: now, reason,
      refs: active.map((row) => row.pack_id),
    });
    if (pack.project_id) {
      appendEvent(db, {
        project_id: pack.project_id,
        object_type: 'convention_pack', object_id: packId,
        event_type: 'convention_pack.activated', actor,
        occurred_at: now, reason,
        refs: active.map((row) => row.pack_id),
      });
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getConventionPack(db, packId);
}

export function retireConventionPack(db, packId, patch = {}) {
  const pack = getConventionPack(db, packId);
  if (!pack) throw Object.assign(new Error(`约定包不存在：${packId}`), { status: 404 });
  if (pack.status !== 'active') {
    throw codedError('INVALID_TRANSITION', `约定包当前状态不可退役：${pack.status}`, 409);
  }
  const actor = required(patch, 'retired_by', 'retiredBy');
  const reason = required(patch, 'reason');
  const now = nowIso();
  db.prepare("UPDATE convention_packs SET status = 'retired' WHERE pack_id = ?").run(packId);
  appendDefinitionEvent(db, {
    project_id: pack.project_id,
    object_type: 'convention_pack', object_id: packId,
    event_type: 'convention_pack.retired', actor, occurred_at: now, reason,
  });
  if (pack.project_id) {
    appendEvent(db, {
      project_id: pack.project_id,
      object_type: 'convention_pack', object_id: packId,
      event_type: 'convention_pack.retired', actor,
      occurred_at: now, reason,
    });
  }
  return getConventionPack(db, packId);
}

export function importConventionPack(db, teamPackId, input = {}) {
  const source = getConventionPack(db, teamPackId);
  if (!source) throw Object.assign(new Error(`团队约定模板不存在：${teamPackId}`), { status: 404 });
  if (source.scope !== 'team' || source.status !== 'active') {
    throw codedError('PACK_NOT_IMPORTABLE', '只能导入 active 状态的团队约定模板', 409);
  }
  const projectId = required(input, 'project_id', 'projectId');
  assertProjectExists(db, projectId);
  return createConventionPack(db, {
    name: pick(input, 'name') ?? source.name,
    description: pick(input, 'description') ?? source.description,
    scope: 'project',
    project_id: projectId,
    rules: source.rules,
    version: 1,
    created_by: pick(input, 'created_by', 'createdBy'),
    imported_from: source.pack_id,
  });
}

export { normalizeRules };
