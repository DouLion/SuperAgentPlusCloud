// 外部工具只读适配路由（G 枝）：摄入事实、引用证据、关联任务、订阅投递。
// 这些接口只接收事实，不改变任务、提交或制品状态。

import { bearerToken, resolveRequestActor } from '../../auth/policy.mjs';
import { activeDelegationFor } from '../../db/actors.mjs';
import { createFact, getFact, linkTaskFacts, listFacts, listTaskFacts } from '../../db/facts.mjs';
import { codedError } from '../../db/json.mjs';

/**
 * 适配器主体：必须是 service 或 agent。
 * 人类请走普通接口，避免把人的判断混进「系统事实」。
 */
function requireIntegrationActor(db, req, projectId = null) {
  const token = bearerToken(req);
  if (!token) throw codedError('AUTH_REQUIRED', '此接口需要 Authorization: Bearer <token>', 401);
  const resolved = resolveRequestActor(db, req);
  if (!resolved) throw codedError('AUTH_INVALID', '凭据无效、已撤销或已过期', 401);

  const { actor } = resolved;
  if (actor.type === 'human') {
    throw codedError(
      'INTEGRATION_ENDPOINT_HUMAN',
      '人类主体请使用普通接口；integrations/* 只接收系统事实',
      400,
    );
  }
  if (actor.type === 'agent' && projectId) {
    const delegation = activeDelegationFor(db, actor.actor_id, projectId);
    if (!delegation) {
      throw codedError(
        'DELEGATION_REQUIRED',
        `Agent ${actor.actor_id} 在项目 ${projectId} 上没有有效委派`,
        403,
      );
    }
  }
  return { actor };
}

export const ROUTES = [
  {
    method: 'POST',
    pattern: '/integrations/:source/facts',
    handler: ({ db, req, params, body }) => {
      const projectId = body?.project_id ?? body?.projectId;
      const auth = requireIntegrationActor(db, req, projectId);
      const result = createFact(db, {
        ...body,
        source: body?.source ?? params.source,
        actor_id: body?.actor_id ?? body?.actorId ?? auth.actor.actor_id,
      });
      return {
        status: result.deduplicated ? 200 : 201,
        body: {
          fact: result.fact,
          deduplicated: result.deduplicated,
          note: '外部事实仅为证据，不代表任务完成',
        },
      };
    },
  },
  {
    method: 'GET',
    pattern: '/integrations/facts',
    handler: ({ db, url }) => listFacts(db, Object.fromEntries(url.searchParams)),
  },
  {
    method: 'GET',
    pattern: '/integrations/facts/:id',
    handler: ({ db, params }) => {
      const fact = getFact(db, params.id);
      if (!fact) {
        return { status: 404, body: { ok: false, code: 'FACT_NOT_FOUND', error: `事实不存在：${params.id}` } };
      }
      return fact;
    },
  },
  {
    method: 'POST',
    pattern: '/tasks/:id/link-facts',
    handler: ({ db, params, body }) => ({
      status: 200,
      body: linkTaskFacts(db, params.id, body?.fact_ids ?? body?.factIds, body?.linked_by ?? body?.linkedBy),
    }),
  },
  {
    method: 'GET',
    pattern: '/tasks/:id/facts',
    handler: ({ db, params }) => ({
      task_id: params.id,
      facts: listTaskFacts(db, params.id),
      note: '外部事实仅为证据，不代表任务完成',
    }),
  },
];
