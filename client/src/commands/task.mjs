// sap task：任务级附加动作（G 枝）——关联外部事实、查看事实。
// 只记录证据关联，不改变任务状态。

import { api } from '../api.mjs';
import { collectFlagValues, parseArgs, requireFlag } from '../args.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'task',
  usage: 'sap task link-facts --task <task_id> --fact <fact_id> [--fact ...] [--by <名字>] ｜ '
    + 'sap task facts --task <task_id>',
};

export async function run(argv, io = {}) {
  const out = io.stdout || console.log;
  const err = io.stderr || console.error;
  const [sub, ...rest] = argv;
  const { flags } = parseArgs(rest);
  const options = { url: io.url, env: io.env, fetchImpl: io.fetchImpl };

  try {
    if (sub === 'link-facts') {
      const factIds = collectFlagValues(rest, 'fact');
      if (!factIds.length) {
        err('缺少 --fact <fact_id>（可重复）');
        return 1;
      }
      const result = await api.linkTaskFacts(requireFlag(flags, 'task'), {
        fact_ids: factIds,
        linked_by: flags.by,
      }, options);
      out(`已关联 ${result.facts.length} 条事实到任务 ${result.task_id}`);
      out(result.note);
      return 0;
    }

    if (sub === 'facts') {
      const result = await api.listTaskFacts(requireFlag(flags, 'task'), options);
      if (!result.facts.length) {
        out('该任务还没有关联的外部事实');
        return 0;
      }
      result.facts.forEach((fact) => out(
        `${fact.fact_id}  ${fact.source}/${fact.kind}  ${fact.external_id}`,
      ));
      out(result.note);
      return 0;
    }

    err(`用法：${meta.usage}`);
    return 1;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}
