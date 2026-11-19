// sap fact：外部事实（G 枝）。只读证据：可以摄入、查看、关联到任务，但不改变任务状态。

import fs from 'node:fs';
import { api } from '../api.mjs';
import { optionalFlag, parseArgs, requireFlag } from '../args.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'fact',
  usage: 'sap fact add --project <id> --source git|ci|issue|chat|other --kind commit|build|test_run|issue|message '
    + '--external-id <id> --file payload.json\n'
    + '       sap fact list [--project <id>] [--source <s>] [--kind <k>] [--limit N]\n'
    + '       sap fact show --fact <fact_id>',
};

function readPayload(path) {
  const text = fs.readFileSync(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`payload 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function run(argv, io = {}) {
  const out = io.stdout || console.log;
  const err = io.stderr || console.error;
  const [sub, ...rest] = argv;
  const { flags } = parseArgs(rest);
  const options = { url: io.url, env: io.env, fetchImpl: io.fetchImpl };

  try {
    if (sub === 'add') {
      const source = requireFlag(flags, 'source');
      const result = await api.createFact(source, {
        project_id: requireFlag(flags, 'project'),
        kind: requireFlag(flags, 'kind'),
        external_id: requireFlag(flags, 'external-id'),
        payload: readPayload(requireFlag(flags, 'file')),
      }, options);
      const tag = result.deduplicated ? '已存在（幂等命中）' : '已记录';
      out(`${tag}：${result.fact.fact_id}  ${result.fact.source}/${result.fact.kind}:${result.fact.external_id}`);
      out(result.note);
      return 0;
    }

    if (sub === 'list') {
      const rows = await api.listFacts({
        project_id: optionalFlag(flags, 'project'),
        source: optionalFlag(flags, 'source'),
        kind: optionalFlag(flags, 'kind'),
        limit: optionalFlag(flags, 'limit'),
      }, options);
      if (!rows.length) {
        out('还没有外部事实');
        return 0;
      }
      rows.forEach((row) => out(
        `${row.fact_id}  ${row.source}/${row.kind}  ${row.external_id}  ${row.received_at}`,
      ));
      return 0;
    }

    if (sub === 'show') {
      const fact = await api.getFact(requireFlag(flags, 'fact'), options);
      out(`事实：${fact.fact_id}`);
      out(`  来源：${fact.source}/${fact.kind}  外部 ID：${fact.external_id}`);
      out(`  项目：${fact.project_id}  接收于：${fact.received_at}`);
      out(`  上报主体：${fact.actor_id || '—'}`);
      out(`  载荷：${JSON.stringify(fact.payload)}`);
      return 0;
    }

    err(`用法：${meta.usage}`);
    return 1;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}
