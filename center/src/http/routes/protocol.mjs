// 协议层 HTTP 路由（P3）：未知结果查询与 outbox 管理。

import { commandResult } from '../../protocol/idempotency.mjs';
import { dispatchOutbox, listOutbox } from '../../protocol/outbox.mjs';

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
    handler: ({ db, body }) => {
      const result = dispatchOutbox(db, { limit: body?.limit });
      return {
        delivered: result.delivered,
        failed: result.failed,
        note: '当前没有外部订阅者，投递器为空操作，仅标记已投递',
      };
    },
  },
];
