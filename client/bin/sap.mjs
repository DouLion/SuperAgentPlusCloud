#!/usr/bin/env node
// SuperAgentPlus 命令行客户端入口。
// 只负责参数分发与退出码；业务逻辑在 src/commands/*.mjs，请求在 src/api.mjs。

import { buildHelp, PLANNED_COMMANDS, DEFAULT_CENTER_URL } from '../src/help.mjs';
import { run as runSubmit } from '../src/commands/submit.mjs';
import { run as runDecide } from '../src/commands/decide.mjs';
import { run as runShow } from '../src/commands/show.mjs';
import { run as runTasks } from '../src/commands/tasks.mjs';
import { run as runClaim } from '../src/commands/claim.mjs';
import { run as runRelease } from '../src/commands/release.mjs';
import { run as runHeartbeat } from '../src/commands/heartbeat.mjs';
import { run as runDeliver } from '../src/commands/deliver.mjs';
import { run as runReview } from '../src/commands/review.mjs';
import { run as runChange } from '../src/commands/change.mjs';
import { run as runImpact } from '../src/commands/impact.mjs';
import { run as runTrunk } from '../src/commands/trunk.mjs';
import { run as runAdvise } from '../src/commands/advise.mjs';
import { run as runPlan } from '../src/commands/plan.mjs';
import { run as runImpacts } from '../src/commands/impacts.mjs';
import { run as runConvention } from '../src/commands/convention.mjs';
import { run as runWorkflow } from '../src/commands/workflow.mjs';
import { run as runArtifact } from '../src/commands/artifact.mjs';
import { run as runOrchestrate } from '../src/commands/orchestrate.mjs';
import { run as runActor } from '../src/commands/actor.mjs';
import { run as runDelegate } from '../src/commands/delegate.mjs';
import { run as runMember } from '../src/commands/member.mjs';
import { run as runCommand } from '../src/commands/command.mjs';
import { run as runOutbox } from '../src/commands/outbox.mjs';
import { run as runAgent } from '../src/commands/agent.mjs';
import { run as runCaps } from '../src/commands/caps.mjs';
import { run as runCandidates } from '../src/commands/candidates.mjs';
import { run as runObserve } from '../src/commands/observe.mjs';
import { run as runMaterial } from '../src/commands/material.mjs';
import { run as runNotify } from '../src/commands/notify.mjs';
import { run as runAdmin } from '../src/commands/admin.mjs';
import { run as runFact } from '../src/commands/fact.mjs';
import { run as runRepo } from '../src/commands/repo.mjs';
import { run as runTask } from '../src/commands/task.mjs';
import { run as runSubscribe } from '../src/commands/subscribe.mjs';

/** 提取全局 --token：写入 SAP_TOKEN 后从参数里移除，避免各命令重复处理。 */
function extractToken(argv) {
  const rest = [];
  let token;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--token') {
      token = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--token=')) {
      token = arg.slice('--token='.length);
      continue;
    }
    rest.push(arg);
  }
  if (token) process.env.SAP_TOKEN = token;
  return rest;
}

const args = extractToken(process.argv.slice(2));
const centerUrl = process.env.CENTER_URL || DEFAULT_CENTER_URL;

const handlers = new Map([
  ['submit', runSubmit],
  ['decide', runDecide],
  ['show', runShow],
  ['tasks', runTasks],
  ['claim', runClaim],
  ['release', runRelease],
  ['heartbeat', runHeartbeat],
  ['deliver', runDeliver],
  ['review', runReview],
  ['change', runChange],
  ['impact', runImpact],
  ['trunk', runTrunk],
  ['advise', runAdvise],
  ['plan', runPlan],
  ['impacts', runImpacts],
  ['convention', runConvention],
  ['workflow', runWorkflow],
  ['artifact', runArtifact],
  ['orchestrate', runOrchestrate],
  ['actor', runActor],
  ['delegate', runDelegate],
  ['member', runMember],
  ['command', runCommand],
  ['outbox', runOutbox],
  ['agent', runAgent],
  ['caps', runCaps],
  ['candidates', runCandidates],
  ['observe', runObserve],
  ['material', runMaterial],
  ['notify', runNotify],
  ['admin', runAdmin],
  ['fact', runFact],
  ['repo', runRepo],
  ['task', runTask],
  ['subscribe', runSubscribe],
]);

function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    if (argv.length === 0) {
      // 无参数：打印帮助但以非零码提示用法缺失。
      console.error(buildHelp(centerUrl));
      console.error('\n提示：请指定命令，例如 sap --help。');
      return 1;
    }
    console.log(buildHelp(centerUrl));
    return 0;
  }

  const command = argv[0];
  const known = PLANNED_COMMANDS.some((cmd) => cmd.name === command);

  if (!known) {
    console.error(`未知命令：${command}`);
    console.error(buildHelp(centerUrl));
    return 1;
  }

  const handler = handlers.get(command);
  if (!handler) {
    // 已规划但尚未实现的命令：明确报错，不静默成功。
    console.error(`命令「${command}」尚未实现（当前进度见 docs/05_实施计划.md）。`);
    return 1;
  }

  return handler(argv.slice(1));
}

// 命令是异步的：等待其完成后再以对应退出码结束进程。
Promise.resolve()
  .then(() => main(args))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
