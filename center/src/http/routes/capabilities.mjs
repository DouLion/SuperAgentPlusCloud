// 能力路由（P4）：人类可为任意主体设置能力；Agent 只能声明自己的。
// 能力只影响推荐排序，不产生任何授权。

import { getActor } from '../../db/actors.mjs';
import { listCapabilities, setCapability } from '../../db/capabilities.mjs';
import { bearerToken, resolveRequestActor } from '../../auth/policy.mjs';
import { codedError } from '../../db/json.mjs';

/** 写能力：必须带有效 token；human 可改任意主体，agent/service 只能改自己。 */
function requireCapabilityWriter(db, req, targetActorId) {
  const token = bearerToken(req);
  if (!token) throw codedError('AUTH_REQUIRED', '此操作需要 Authorization: Bearer <token>', 401);
  const resolved = resolveRequestActor(db, req);
  if (!resolved) throw codedError('AUTH_INVALID', '凭据无效、已撤销或已过期', 401);
  const { actor } = resolved;
  if (actor.type !== 'human' && actor.actor_id !== targetActorId) {
    throw codedError('HUMAN_ACTION_REQUIRED', '只有人类或主体本人可以设置能力', 403);
  }
  return actor;
}

export const ROUTES = [
  {
    method: 'GET',
    pattern: '/actors/:id/capabilities',
    handler: ({ db, params }) => {
      const actor = getActor(db, params.id);
      if (!actor) return { status: 404, body: { ok: false, error: `主体不存在：${params.id}` } };
      return listCapabilities(db, params.id);
    },
  },
  {
    method: 'POST',
    pattern: '/actors/:id/capabilities',
    handler: ({ db, params, body, req }) => {
      const actor = getActor(db, params.id);
      if (!actor) return { status: 404, body: { ok: false, error: `主体不存在：${params.id}` } };
      requireCapabilityWriter(db, req, params.id);
      return { status: 201, body: setCapability(db, params.id, body) };
    },
  },
];
