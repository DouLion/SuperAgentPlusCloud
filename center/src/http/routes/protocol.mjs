// 协议层 HTTP 路由（P3）：未知结果查询、outbox 管理与订阅（G 枝扩展投递）。

import { commandResult } from '../../protocol/idempotency.mjs';
import {
  createSubscription,
  disableSubscription,
  dispatchOutbox,
  listOutbox,
  listSubscriptions,
} from '../../protocol/outbox.mjs';

export const ROUTES = [
  {
    method: 'GET',
    pattern: '/command-results/:id',
    handler: ({ db, params }) => {
      const result = commandResult(db, params.id);
      if (!result) {
        return {
          status: 404,
          body: { ok: false, code: 'COMMAND_NOT_FOUND', error: `命令结果不存在：${params.id}` },
        };
      }
      return result;
    },
  },
  {
    method: 'GET',
    pattern: '/outbox',
    handler: ({ db, url }) => listOutbox(db, {
      status: url.searchParams.get('status') ?? 'pending',
      limit: url.searchParams.get('limit'),
    }),
  },
  {
    method: 'POST',
    pattern: '/outbox/dispatch',
    handler: async ({ db, body }) => {
      const result = await dispatchOutbox(db, { limit: body?.limit });
      return {
        delivered: result.delivered,
        failed: result.failed,
        subscriptions: result.subscriptions,
        note: result.subscriptions
          ? '已按订阅投递；失败项会退避重试'
          : '当前没有外部订阅者，投递器为空操作，仅标记已投递',
      };
    },
  },
  {
    method: 'POST',
    pattern: '/outbox/subscriptions',
    handler: ({ db, body }) => ({ status: 201, body: createSubscription(db, body) }),
  },
  {
    method: 'GET',
    pattern: '/outbox/subscriptions',
    handler: ({ db, url }) => listSubscriptions(db, {
      include_disabled: url.searchParams.get('include_disabled') === 'true',
    }),
  },
  {
    method: 'DELETE',
    pattern: '/outbox/subscriptions/:id',
    handler: ({ db, params }) => disableSubscription(db, params.id),
  },
];
