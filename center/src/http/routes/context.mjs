// 上下文与候选路由（P4）：任务上下文快照、按编排来源推断角色的候选人推荐。
import { listAiSuggestions } from '../../db/ai.mjs';
import { activeDelegationFor } from '../../db/actors.mjs';
import { matchActors } from '../../db/capabilities.mjs';
import { getTask } from '../../db/tasks.mjs';
import { getWorkflowTemplate } from '../../db/workflows.mjs';
import { bearerToken, resolveRequestActor } from '../../auth/policy.mjs';
import { buildTaskContext } from '../../context/bundle.mjs';

/** 解析可选主体：无 token 返回 null（上下文降级）；带无效 token 则拒绝。 */
function optionalActor(db, req) {
  const token = bearerToken(req);
  if (!token) return { actor: null, delegation: null };
  const resolved = resolveRequestActor(db, req);
  if (!resolved) {
    throw Object.assign(new Error('凭据无效、已撤销或已过期'), { status: 401, code: 'AUTH_INVALID' });
  }
  return { actor: resolved.actor, delegation: null };
}

/**
 * 从任务的编排建议推断模板节点。
 * 只有「被采纳的 contract_orchestration 建议」能提供 node_key，避免猜测。
 */
function resolveTaskNode(db, task) {
  if (!task.requirement_id) return { reason: '任务没有关联需求，无法推断编排节点' };
  const suggestions = listAiSuggestions(db, {
    requirement_id: task.requirement_id,
    kind: 'contract_orchestration',
  });
  for (const suggestion of suggestions) {
    const payload = suggestion.payload;
    if (!payload?.adopted_at) continue;
    const matched = (payload.tasks || []).find((item) => item.purpose === task.purpose);
    if (!matched) continue;
    const template = payload.workflow_template_id
      ? getWorkflowTemplate(db, payload.workflow_template_id)
      : null;
    const node = template?.nodes?.find((item) => item.key === matched.node_key);
    return { suggestion, template, node, nodeKey: matched.node_key };
  }
  return { reason: '该任务不是由已采纳的契约编排生成的，无法推断角色' };
}

export const ROUTES = [
  {
    method: 'GET',
    pattern: '/tasks/:id/context',
    handler: ({ db, params, req }) => {
      const task = getTask(db, params.id);
      if (!task) return { status: 404, body: { ok: false, error: `任务不存在：${params.id}` } };
      const { actor } = optionalActor(db, req);
      let delegation = null;
      if (actor?.type === 'agent') {
        delegation = activeDelegationFor(db, actor.actor_id, task.project_id);
      }
      return buildTaskContext(db, params.id, { actor, delegation });
    },
  },
  {
    method: 'GET',
    pattern: '/tasks/:id/candidates',
    handler: ({ db, params }) => {
      const task = getTask(db, params.id);
      if (!task) return { status: 404, body: { ok: false, error: `任务不存在：${params.id}` } };

      const resolved = resolveTaskNode(db, task);
      const explicitHint = task.role_hint ?? null;
      const roleHint = explicitHint ?? resolved.node?.role_hint ?? null;
      if (!roleHint) {
        return {
          task_id: task.task_id,
          node_key: null,
          role_hint: null,
          source: 'none',
          candidates: [],
          reason: resolved.reason ?? '任务没有 role_hint，也没有可推断的编排节点',
        };
      }

      const candidates = matchActors(db, { project_id: task.project_id, role_hint: roleHint });
      return {
        task_id: task.task_id,
        node_key: explicitHint ? null : (resolved.nodeKey ?? null),
        role_hint: roleHint,
        source: explicitHint ? 'task' : 'workflow',
        candidates,
        note: '候选只用于推荐，领取仍需自行认领并由策略校验',
      };
    },
  },
];
