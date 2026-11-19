// sap agent：Agent 接入命令（P4）。
// 所有子命令都要求 Bearer token（--token 或 SAP_TOKEN），主体必须是 agent 或 service。

import { api } from '../api.mjs';
import { collectFlagValues, optionalFlag, parseArgs, requireFlag } from '../args.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'agent',
  usage: 'sap agent inbox|claim|heartbeat|deliver|release ...',
};

function printInbox(out, result) {
  out(`可认领任务：${result.count} 个（actor：${result.actor_id}）`);
  for (const item of result.items) {
    out(`  ${item.task_id}  ${item.purpose ?? '(无描述)'}`);
    out(`    完成条件：${(item.done_when || []).join('；') || '—'}`);
    out(`    租约：${item.lease_seconds}s`);
  }
}

function printClaim(out, result) {
  out(`已认领：${result.claim.claim_id}（角色 ${result.claim.role}）`);
  out(`  任务：${result.task.task_id}  状态：${result.task.status}`);
  out(`  fencing_token：${result.claim.fencing_token}`);
  out(`  租约到期：${result.claim.lease_expires_at}`);
  out(`  上下文摘要：${result.context_digest}`);
}

export async function run(argv, io = {}) {
  const out = io.stdout || console.log;
  const err = io.stderr || console.error;
  const [sub, ...rest] = argv;
  const { flags } = parseArgs(rest);

  try {
    if (sub === 'inbox') {
      const result = await api.agentInbox({
        actor_id: optionalFlag(flags, 'actor'),
        project_id: optionalFlag(flags, 'project'),
        limit: optionalFlag(flags, 'limit'),
      });
      printInbox(out, result);
      return 0;
    }

    if (sub === 'claim') {
      const result = await api.agentClaim({
        task_id: requireFlag(flags, 'task'),
        actor_id: optionalFlag(flags, 'actor'),
        ttl_seconds: optionalFlag(flags, 'ttl'),
        role: optionalFlag(flags, 'role'),
      });
      printClaim(out, result);
      return 0;
    }

    if (sub === 'heartbeat') {
      const claim = await api.agentHeartbeat({
        claim_id: requireFlag(flags, 'claim'),
        actor_id: optionalFlag(flags, 'actor'),
        ttl_seconds: optionalFlag(flags, 'ttl'),
      });
      out(`已续租：${claim.claim_id}  到期：${claim.lease_expires_at}`);
      return 0;
    }

    if (sub === 'deliver') {
      const commits = collectFlagValues(rest, 'commit');
      if (commits.length === 0) throw new Error('缺少 --commit <repo@hash>（可重复）');
      const gaps = collectFlagValues(rest, 'gap');
      const result = await api.agentDeliver({
        claim_id: requireFlag(flags, 'claim'),
        actor_id: optionalFlag(flags, 'actor'),
        fencing_token: optionalFlag(flags, 'fencing'),
        commit_refs: commits,
        summary: requireFlag(flags, 'summary'),
        self_test: optionalFlag(flags, 'self-test'),
        known_gaps: gaps,
        context_digest: optionalFlag(flags, 'context-digest'),
      });
      out(`已提交：${result.submission.submission_id}`);
      out(`  上下文摘要：${result.context_digest}`);
      return 0;
    }

    if (sub === 'release') {
      const result = await api.agentRelease({
        claim_id: requireFlag(flags, 'claim'),
        actor_id: optionalFlag(flags, 'actor'),
        reason: optionalFlag(flags, 'reason'),
      });
      out(`已释放：${result.claim.claim_id}`);
      return 0;
    }

    err(`用法：${meta.usage}`);
    return 1;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}
