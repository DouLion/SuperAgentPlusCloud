// sap orchestrate：生成 contract_orchestration 建议，或具名采纳为 draft Artifact + open Tasks。

import { api } from '../api.mjs';
import { parseArgs, requireFlag, optionalFlag } from '../args.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'orchestrate',
  usage: 'sap orchestrate --requirement <req_id> [--workflow <wft_id>] ｜ sap orchestrate adopt --suggestion <sug_id> --by <名字> --contract-name <名称>',
};

function printDraft(out, result) {
  out(`编排建议：${result.suggestion.suggestion_id}（未生效）`);
  out(`模板：${result.draft.workflow_template_id}`);
  out(`API 契约：${result.draft.api_contract_draft?.info?.title || '未命名'}`);
  out(`可采纳：${result.draft.adoptable ? '是' : '否'}`);
  if (result.draft.uncertainties?.length) out(`未决项：${result.draft.uncertainties.join('；')}`);
  for (const task of result.draft.tasks || []) {
    out(`  - ${task.node_key}: ${task.purpose} <- [${task.depends_on_node_keys.join(', ')}]`);
  }
}

export async function run(argv, io = {}) {
  const out = io.stdout || console.log;
  const err = io.stderr || console.error;
  const [sub, ...rest] = argv;
  try {
    if (sub === 'adopt') {
      const { flags } = parseArgs(rest);
      const result = await api.adoptOrchestration(requireFlag(flags, 'suggestion'), {
        created_by: requireFlag(flags, 'by'),
        contract_name: requireFlag(flags, 'contract-name'),
      });
      out(`已采纳：draft 契约 ${result.artifact.artifact_id}（未发布）`);
      out(`已创建 ${result.tasks.length} 个 open 任务：`);
      for (const task of result.tasks) out(`  - ${task.node_key}: ${task.task_id} [${task.status}]`);
      return 0;
    }
    const { flags } = parseArgs(argv);
    const result = await api.orchestrateRequirement(requireFlag(flags, 'requirement'), {
      workflow_template_id: optionalFlag(flags, 'workflow'),
    });
    printDraft(out, result);
    return 0;
  } catch (error) { printError(error, err); return 1; }
}
