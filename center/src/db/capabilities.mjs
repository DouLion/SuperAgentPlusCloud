// Agent 能力（P4）：能力只用于推荐匹配，不构成授权。
// 授权仍由 delegations 与 auth/policy 判定。

import { activeDelegationFor, getActor, listActors } from './actors.mjs';
import { nowIso, pick, required } from './json.mjs';

export const CAPABILITY_LEVELS = ['basic', 'standard', 'expert'];

/** 能力等级权重：用于匹配排序，不对外承诺精确分数。 */
const LEVEL_WEIGHT = { basic: 1, standard: 2, expert: 3 };

/** 设置（或更新）某个主体的能力。 */
export function setCapability(db, actorId, input = {}) {
  const actor = getActor(db, actorId);
  if (!actor) throw Object.assign(new Error(`主体不存在：${actorId}`), { status: 404 });
  const key = String(required(input, 'key')).trim();
  if (!key) throw new Error('key 不能为空');
  const level = pick(input, 'level') ?? 'standard';
  if (!CAPABILITY_LEVELS.includes(level)) {
    throw new Error(`非法的能力等级：${level}`);
  }
  const now = nowIso();
  db.prepare(`INSERT INTO actor_capabilities (actor_id, key, level, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (actor_id, key) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`)
    .run(actorId, key, level, now);
  return { actor_id: actorId, key, level, updated_at: now };
}

/** 列出某个主体的全部能力，按 key 升序。 */
export function listCapabilities(db, actorId) {
  return db.prepare('SELECT * FROM actor_capabilities WHERE actor_id = ? ORDER BY key ASC').all(actorId);
}

/** 取主体的能力映射 key → level。 */
function capabilityMap(db, actorId) {
  const map = new Map();
  for (const row of listCapabilities(db, actorId)) map.set(row.key, row.level);
  return map;
}

/**
 * 推荐可执行该工作的主体。
 * - 只返回 active 的 agent / service；
 * - 给了 project_id 时，只保留在该项目有有效委派的主体（仅用于过滤候选，不代表授权）；
 * - 给了 role_hint 时要求具备同名能力；给了 required_keys 时要求全部具备；
 * - 按能力权重排序，无匹配返回空数组。
 */
export function matchActors(db, query = {}) {
  const projectId = pick(query, 'project_id', 'projectId');
  const roleHint = pick(query, 'role_hint', 'roleHint');
  const requiredKeys = pick(query, 'required_keys', 'requiredKeys') ?? [];
  const keys = Array.isArray(requiredKeys) ? requiredKeys.filter(Boolean) : [];

  const candidates = listActors(db, { status: 'active' })
    .filter((actor) => actor.type === 'agent' || actor.type === 'service');

  const matched = [];
  for (const actor of candidates) {
    if (projectId && actor.type === 'agent' && !activeDelegationFor(db, actor.actor_id, projectId)) {
      continue;
    }
    const caps = capabilityMap(db, actor.actor_id);
    if (roleHint && !caps.has(roleHint)) continue;
    if (keys.some((key) => !caps.has(key))) continue;

    let score = 0;
    if (roleHint) score += LEVEL_WEIGHT[caps.get(roleHint)] ?? 0;
    for (const key of keys) score += LEVEL_WEIGHT[caps.get(key)] ?? 0;

    matched.push({
      actor_id: actor.actor_id,
      display_name: actor.display_name,
      type: actor.type,
      score,
      capabilities: Object.fromEntries(caps),
    });
  }

  matched.sort((a, b) => b.score - a.score || a.actor_id.localeCompare(b.actor_id));
  return matched;
}
