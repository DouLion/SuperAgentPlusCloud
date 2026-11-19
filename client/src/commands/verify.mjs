// sap verify：核对提交引用的 commit 是否真实存在于项目 git 事实中。
// 只写核对标记，不改变提交与任务状态。

import { api } from '../api.mjs';
import { parseArgs, requireFlag } from '../args.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'verify',
  usage: 'sap verify --submission <sub_id>',
};

export async function run(argv, io = {}) {
  const out = io.stdout || console.log;
  const err = io.stderr || console.error;
  const { flags } = parseArgs(argv);
  const options = { url: io.url, env: io.env, fetchImpl: io.fetchImpl };

  try {
    const result = await api.verifySubmissionCommits(requireFlag(flags, 'submission'), options);
    if (!result.verified.length && !result.unverified.length) {
      out('该提交没有 commit 引用');
      return 0;
    }
    for (const one of result.verified) {
      out(`已核对  ${String(one.hash).slice(0, 12)}  仓库 ${one.repository_id ?? '—'}`);
    }
    for (const one of result.unverified) {
      out(`未找到  ${String(one.hash || '(空)').slice(0, 12)}  ${one.reason}`);
    }
    out(`核对时间 ${result.checked_at}`);
    return 0;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}
