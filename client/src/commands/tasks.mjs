// sap tasks：查看项目下的任务列表与完成条件。

import { api } from '../api.mjs';
import { parseArgs, requireFlag, optionalFlag } from '../args.mjs';
import { TASK_STATUSES } from '../limits.mjs';

export const meta = {
  name: 'tasks',
  usage: 'sap tasks --project <id> [--status open|claimed|...] [--requirement <id>]',
};

function line(out, label, value) {
  if (value === undefined || value === null || value === '') return;
  out(`  ${label}：${value}`);
}

function renderTask(out, task) {
  out(`任务 ${task.task_id}`);
  line(out, '状态', task.status);
  line(out, '目标', task.purpose);
  line(out, '范围', task.scope);
  if (task.non_scope) line(out, '非范围', task.non_scope);
  line(out, '需求', task.requirement_id);
  if (task.serves_item_ids.length > 0) {
    line(out, '服务条目', task.serves_item_ids.join(', '));
  }
  if (task.blocked_by.length > 0) {
    line(out, '前置阻塞', task.blocked_by.join(', '));
  }
  if (task.done_when.length > 0) {
    out('  完成条件：');
    for (const item of task.done_when) out(`    - ${item}`);
  }
  if (task.acceptance_evidence.length > 0) {
    line(out, '预期证据', task.acceptance_evidence.join('；'));
  }
}

/**
 * @param {string[]} argv
 * @param {object} [io] { stdout, stderr }
 * @returns {Promise<number>} 退出码
 */
export async function run(argv, io = {}) {
  const out = io.stdout || ((line) => console.log(line));
  const err = io.stderr || ((line) => console.error(line));

  const { flags } = parseArgs(argv);
  let projectId;
  try {
    projectId = requireFlag(flags, 'project', '<id>');
  } catch (error) {
    err(error.message);
    err(`用法：${meta.usage}`);
    return 1;
  }

  const status = optionalFlag(flags, 'status');
  if (status !== undefined && !TASK_STATUSES.includes(status)) {
    err(`--status 只能是 ${TASK_STATUSES.join(' / ')}，当前为：${status}`);
    return 1;
  }

  try {
    const query = { project_id: projectId };
    if (status !== undefined) query.status = status;
    const requirementId = optionalFlag(flags, 'requirement');
    if (requirementId !== undefined) query.requirement_id = requirementId;

    const tasks = await api.listTasks(query);
    if (tasks.length === 0) {
      out('（没有匹配的任务）');
      return 0;
    }

    out(`任务（${tasks.length}）：`);
    for (const task of tasks) {
      out('');
      renderTask(out, task);
    }
    return 0;
  } catch (error) {
    err(error.message);
    return 1;
  }
}
