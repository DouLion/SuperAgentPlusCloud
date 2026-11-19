// sap observe：观测层命令（P5）。只读，不改变任何业务状态。

import { api } from '../api.mjs';
import { parseArgs } from '../args.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'observe',
  usage: 'sap observe actors ｜ stuck [--project <id>] ｜ stats [--project <id>]',
};

const PRESENCE_TEXT = { online: '在线', idle: '空闲', never: '从未使用' };

function printActors(out, result) {
  if (!result.actors.length) {
    out('还没有任何主体');
    return;
  }
  out(`主体 ${result.actors.length} 个（生成于 ${result.generated_at}）`);
  for (const actor of result.actors) {
    const caps = Object.keys(actor.capabilities || {}).join(',') || '—';
    out(`  ${actor.actor_id}  ${actor.type.padEnd(7)} ${actor.status.padEnd(8)} `
      + `${PRESENCE_TEXT[actor.presence] || actor.presence}  认领 ${actor.active_claims}  能力 ${caps}`);
  }
}

function printStuck(out, result) {
  if (!result.items.length) {
    out('没有卡住的任务');
    return;
  }
  out(`卡住任务 ${result.count} 条`);
  for (const item of result.items) {
    const who = item.actor_id ? `  主体 ${item.actor_id}` : '';
    out(`  [${item.kind}] ${item.task_id}${who}  ${item.detail}`);
  }
}

function printStats(out, stats) {
  const status = Object.entries(stats.tasks_by_status || {})
    .map(([key, value]) => `${key}=${value}`)
    .join(' ') || '—';
  out(`项目：${stats.project_id || '(全部)'}  任务 ${stats.tasks_total}`);
  out(`  状态分布：${status}`);
  out(`  平均领取时长：${stats.avg_claim_latency_ms === null ? '—' : `${Math.round(stats.avg_claim_latency_ms / 1000)}s`}`);
  out(`  租约过期率：${(stats.lease_expiry_rate * 100).toFixed(2)}%`);
  out(`  提交→评审：${stats.avg_review_latency_ms === null ? '—' : `${Math.round(stats.avg_review_latency_ms / 60000)}min`}`);
  out(`  幂等回放：${stats.idempotency_replays}  待投递事件：${stats.outbox_pending}`);
}

export async function run(argv, io = {}) {
  const out = io.stdout || console.log;
  const err = io.stderr || console.error;
  const { positionals, flags } = parseArgs(argv);
  const sub = positionals[0];
  // 允许注入 url / env / fetchImpl，测试与多环境都走同一入口。
  const options = { url: io.url, env: io.env, fetchImpl: io.fetchImpl };

  try {
    if (sub === 'actors') {
      printActors(out, await api.observabilityActors(options));
      return 0;
    }
    if (sub === 'stuck') {
      printStuck(out, await api.observabilityStuck({ project_id: flags.project }, options));
      return 0;
    }
    if (sub === 'stats') {
      printStats(out, await api.observabilityStats({ project_id: flags.project }, options));
      return 0;
    }
    err('用法：sap observe actors | stuck [--project <id>] | stats [--project <id>]');
    return 1;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}
