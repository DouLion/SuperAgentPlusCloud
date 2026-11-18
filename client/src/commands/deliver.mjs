// sap deliver：登记任务成果提交（commit 引用、自测证据与已知缺口）。

import { api } from '../api.mjs';
import { parseArgs, requireFlag, optionalFlag, collectFlagValues } from '../args.mjs';

export const meta = {
  name: 'deliver',
  usage:
    'sap deliver --task <task_id> --worker <worker_id> --commit <repo@hash> [--summary ...] [--self-test ...] [--gap ...]',
};

/** 解析 repo@hash 形式的 commit 引用为结构化对象。 */
function parseCommitRef(raw, index) {
  const at = raw.indexOf('@');
  if (at <= 0 || at === raw.length - 1) {
    throw new Error(`--commit 第 ${index + 1} 项格式应为 repo@hash，当前为：${raw}`);
  }
  return { repo: raw.slice(0, at), hash: raw.slice(at + 1) };
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
  const rawCommits = collectFlagValues(argv, 'commit');
  const gaps = collectFlagValues(argv, 'gap');

  let taskId;
  let workerId;
  try {
    taskId = requireFlag(flags, 'task', '<task_id>');
    workerId = requireFlag(flags, 'worker', '<worker_id>');
  } catch (error) {
    err(error.message);
    err(`用法：${meta.usage}`);
    return 1;
  }

  if (rawCommits.length === 0) {
    err('缺少 --commit <repo@hash>：至少需要一个 commit 引用');
    err(`用法：${meta.usage}`);
    return 1;
  }

  let commitRefs;
  try {
    commitRefs = rawCommits.map(parseCommitRef);
  } catch (error) {
    err(error.message);
    err(`用法：${meta.usage}`);
    return 1;
  }

  try {
    const submission = await api.createSubmission(taskId, {
      commit_refs: commitRefs,
      // 未显式给出摘要时给出可读默认值，便于快速登记。
      summary: optionalFlag(flags, 'summary') ?? `任务 ${taskId} 的成果提交`,
      self_test: optionalFlag(flags, 'self-test'),
      known_gaps: gaps,
      submitted_by: workerId,
    });

    out(`提交已登记：${submission.submission_id}`);
    out(`任务：${taskId}　提交人：${submission.submitted_by}`);
    out('commit 引用：');
    for (const ref of submission.commit_refs) {
      out(`  - ${typeof ref === 'string' ? ref : `${ref.repo}@${ref.hash}`}`);
    }
    if (submission.summary) out(`摘要：${submission.summary}`);
    if (submission.self_test) out(`自测：${submission.self_test}`);
    if (submission.known_gaps.length > 0) {
      out(`已知缺口：${submission.known_gaps.join('；')}`);
    }
    return 0;
  } catch (error) {
    // 服务端错误（如 SUBMISSION_NOT_ALLOWED）原样透出。
    err(error.message);
    return 1;
  }
}
