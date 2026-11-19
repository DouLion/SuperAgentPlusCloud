// 材料与 AI 提取（C 枝）：材料保留原文；提取结果一律 draft，人采纳后才生成正式对象。
// 采纳规则：requirement → 需求；convention → 项目约定包（draft）；decision → 需求并标记待走正式决定。

import { appendEvent } from './events.mjs';
import { assertProjectExists } from './projects.mjs';
import { createRequirement } from './requirements.mjs';
import { createConventionPack } from './conventions.mjs';
import {
  codedError,
  decodeJson,
  encodeJson,
  newId,
  nowIso,
  pick,
  required,
} from './json.mjs';

export const MATERIAL_KINDS = ['meeting', 'design', 'chat', 'doc', 'other'];
export const EXTRACTION_KINDS = ['requirement', 'convention', 'decision'];
export const EXTRACTION_STATUSES = ['draft', 'accepted', 'rejected'];

function parseMaterial(row) {
  return row ?? null;
}

function parseExtraction(row) {
  if (!row) return null;
  return { ...row, payload: decodeJson(row.payload, {}) };
}

/** 新建材料；原文必填，不做事先摘要。 */
export function createMaterial(db, input = {}) {
  const materialId = pick(input, 'material_id', 'materialId') ?? newId('mat');
  const projectId = required(input, 'project_id', 'projectId');
  const title = required(input, 'title');
  const kind = required(input, 'kind');
  const content = required(input, 'content');
  const createdBy = required(input, 'created_by', 'createdBy');

  if (!MATERIAL_KINDS.includes(kind)) throw new Error(`非法的材料类型：${kind}`);
  if (!String(content).trim()) throw new Error('材料原文不能为空');
  assertProjectExists(db, projectId);

  const now = pick(input, 'created_at', 'createdAt') ?? nowIso();
  db.prepare(`INSERT INTO materials (
    material_id, project_id, title, kind, content, source_ref, created_by, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    materialId, projectId, title, kind, String(content),
    pick(input, 'source_ref', 'sourceRef'), createdBy, now,
  );

  appendEvent(db, {
    project_id: projectId,
    object_type: 'material',
    object_id: materialId,
    event_type: 'material.created',
    actor: createdBy,
    occurred_at: now,
    reason: `导入材料：${title}`,
    refs: [],
  });

  return getMaterial(db, materialId);
}

export function getMaterial(db, materialId) {
  return parseMaterial(db.prepare('SELECT * FROM materials WHERE material_id = ?').get(materialId));
}

export function listMaterials(db, query = {}) {
  const clauses = [];
  const params = [];
  for (const key of ['project_id', 'kind']) {
    const value = pick(query, key, key === 'project_id' ? 'projectId' : key);
    if (value) {
      if (key === 'kind' && !MATERIAL_KINDS.includes(value)) throw new Error(`非法的材料类型：${value}`);
      clauses.push(`${key} = ?`);
      params.push(value);
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM materials ${where} ORDER BY created_at DESC, material_id DESC`)
    .all(...params).map(parseMaterial);
}

/** 保存一条提取草稿；不生成任何正式对象。 */
export function createExtraction(db, input = {}) {
  const extractionId = pick(input, 'extraction_id', 'extractionId') ?? newId('ext');
  const materialId = required(input, 'material_id', 'materialId');
  const kind = required(input, 'kind');
  const payload = required(input, 'payload');
  const createdBy = required(input, 'created_by', 'createdBy');

  if (!EXTRACTION_KINDS.includes(kind)) throw new Error(`非法的提取类型：${kind}`);
  if (!getMaterial(db, materialId)) throw Object.assign(new Error(`材料不存在：${materialId}`), { status: 404 });

  const now = pick(input, 'created_at', 'createdAt') ?? nowIso();
  db.prepare(`INSERT INTO material_extractions (
    extraction_id, material_id, kind, payload, raw_response, model,
    status, accepted_ref, created_by, created_at, accepted_at
  ) VALUES (?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?, NULL)`).run(
    extractionId, materialId, kind, encodeJson(payload),
    pick(input, 'raw_response', 'rawResponse') ?? null,
    pick(input, 'model') ?? null,
    createdBy, now,
  );
  return getExtraction(db, extractionId);
}

export function getExtraction(db, extractionId) {
  return parseExtraction(
    db.prepare('SELECT * FROM material_extractions WHERE extraction_id = ?').get(extractionId),
  );
}

export function listExtractions(db, query = {}) {
  const clauses = [];
  const params = [];
  for (const [key, column] of [
    ['material_id', 'material_id'], ['status', 'status'], ['kind', 'kind'],
  ]) {
    const value = pick(query, key, key === 'material_id' ? 'materialId' : key);
    if (value) {
      if (key === 'status' && !EXTRACTION_STATUSES.includes(value)) {
        throw new Error(`非法的提取状态：${value}`);
      }
      if (key === 'kind' && !EXTRACTION_KINDS.includes(value)) {
        throw new Error(`非法的提取类型：${value}`);
      }
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM material_extractions ${where}
    ORDER BY created_at ASC, extraction_id ASC`).all(...params).map(parseExtraction);
}

/**
 * 采纳提取草稿。只有人能调用（路由已校验）。
 * - requirement：生成需求，source_ref 指回材料。
 * - convention：生成项目约定包（draft），不自动激活。
 * - decision：生成需求承载讨论，并在 payload 标 pending_decision，等正式决定流程。
 * @returns {{ extraction: object, created: object, kind: string }}
 */
export function acceptExtraction(db, extractionId, input = {}) {
  const extraction = getExtraction(db, extractionId);
  if (!extraction) throw Object.assign(new Error(`提取结果不存在：${extractionId}`), { status: 404 });
  if (extraction.status === 'accepted') {
    throw codedError('EXTRACTION_ALREADY_ACCEPTED', '该提取结果已采纳', 409);
  }
  if (extraction.status === 'rejected') {
    throw codedError('EXTRACTION_REJECTED', '该提取结果已拒绝，不能采纳', 409);
  }

  const actor = required(input, 'actor', 'created_by', 'createdBy');
  const material = getMaterial(db, extraction.material_id);
  const payload = { ...extraction.payload, ...(pick(input, 'overrides') ?? {}) };

  db.exec('BEGIN');
  try {
    let created;
    let acceptedRef;
    let nextPayload = payload;

    if (extraction.kind === 'requirement') {
      const rawText = required(payload, 'raw_text', 'rawText');
      created = createRequirement(db, {
        project_id: material.project_id,
        raw_text: rawText,
        author: actor,
        source_ref: `material:${material.material_id}`,
        claimed_level: pick(payload, 'claimed_level', 'claimedLevel'),
        claimed_reason: pick(payload, 'claimed_reason', 'claimedReason'),
      });
      acceptedRef = created.requirement_id;
    } else if (extraction.kind === 'convention') {
      created = createConventionPack(db, {
        name: required(payload, 'name'),
        description: pick(payload, 'description') ?? `来自材料：${material.title}`,
        scope: 'project',
        project_id: material.project_id,
        status: 'draft',
        rules: required(payload, 'rules'),
        created_by: actor,
      });
      acceptedRef = created.pack_id;
    } else {
      // decision：decisions 必须挂在需求下，因此先生成承载需求，再由人走正式决定流程。
      const question = required(payload, 'question');
      created = createRequirement(db, {
        project_id: material.project_id,
        raw_text: question,
        author: actor,
        source_ref: `material:${material.material_id}`,
        claimed_reason: '来自材料的决定草稿，待正式决定',
      });
      acceptedRef = created.requirement_id;
      nextPayload = {
        ...payload,
        pending_decision: {
          question,
          options: Array.isArray(payload.options) ? payload.options : [],
          chosen: pick(payload, 'chosen') ?? null,
          rationale: pick(payload, 'rationale') ?? null,
        },
      };
    }

    const now = nowIso();
    db.prepare(`UPDATE material_extractions
      SET status = 'accepted', accepted_ref = ?, accepted_at = ?, payload = ?
      WHERE extraction_id = ?`).run(acceptedRef, now, encodeJson(nextPayload), extractionId);

    appendEvent(db, {
      project_id: material.project_id,
      object_type: 'material_extraction',
      object_id: extractionId,
      event_type: 'material_extraction.accepted',
      actor,
      occurred_at: now,
      reason: `采纳${extraction.kind}提取`,
      refs: [material.material_id, acceptedRef],
    });

    db.exec('COMMIT');
    return { extraction: getExtraction(db, extractionId), created, kind: extraction.kind };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 拒绝提取草稿；理由必填。 */
export function rejectExtraction(db, extractionId, input = {}) {
  const extraction = getExtraction(db, extractionId);
  if (!extraction) throw Object.assign(new Error(`提取结果不存在：${extractionId}`), { status: 404 });
  if (extraction.status !== 'draft') {
    throw codedError('INVALID_TRANSITION', `提取结果当前状态不可拒绝：${extraction.status}`, 409);
  }
  const actor = required(input, 'actor', 'created_by', 'createdBy');
  const reason = required(input, 'reason');
  const material = getMaterial(db, extraction.material_id);
  const now = nowIso();

  db.prepare("UPDATE material_extractions SET status = 'rejected' WHERE extraction_id = ?")
    .run(extractionId);
  appendEvent(db, {
    project_id: material.project_id,
    object_type: 'material_extraction',
    object_id: extractionId,
    event_type: 'material_extraction.rejected',
    actor,
    occurred_at: now,
    reason,
    refs: [material.material_id],
  });
  return getExtraction(db, extractionId);
}
