// sap artifact：项目制品 CRUD、校验、发布与文档 URL。

import fs from 'node:fs';
import { api, API_PREFIX, resolveCenterUrl } from '../api.mjs';
import { parseArgs, requireFlag, optionalFlag } from '../args.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'artifact',
  usage: 'sap artifact list|show|create|validate|publish|retire|doc ...',
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function print(out, row) {
  out(`${row.artifact_id}  ${row.type}  ${row.name}  v${row.version}  ${row.status}`);
  out(`  digest：${row.digest}`);
  if (row.source_task_id) out(`  任务：${row.source_task_id}`);
  if (row.supersedes) out(`  替代：${row.supersedes}`);
}

function printValidation(out, result) {
  out(`校验：${result.valid ? '通过' : '未通过'}  must=${result.counts.must || 0} should=${result.counts.should || 0} preference=${result.counts.preference || 0}`);
  for (const item of result.violations || []) {
    out(`  - [${item.severity}] ${item.message}  ${item.pointer}`);
  }
}

export async function run(argv, io = {}) {
  const out = io.stdout || console.log;
  const err = io.stderr || console.error;
  const [sub, ...rest] = argv;
  const { flags } = parseArgs(rest);
  try {
    if (sub === 'list') {
      const rows = await api.listArtifacts({
        project_id: optionalFlag(flags, 'project'),
        type: optionalFlag(flags, 'type'),
        status: optionalFlag(flags, 'status'),
        name: optionalFlag(flags, 'name'),
      });
      rows.forEach((row) => print(out, row)); return 0;
    }
    if (sub === 'show') { print(out, await api.getArtifact(requireFlag(flags, 'artifact'))); return 0; }
    if (sub === 'create') {
      const content = readJson(requireFlag(flags, 'file'));
      const created = await api.createArtifact({
        project_id: requireFlag(flags, 'project'),
        type: requireFlag(flags, 'type'),
        name: requireFlag(flags, 'name'),
        content,
        source_task_id: optionalFlag(flags, 'task'),
        source_submission_id: optionalFlag(flags, 'submission'),
        supersedes: optionalFlag(flags, 'supersedes'),
        created_by: requireFlag(flags, 'by'),
      });
      print(out, created); return 0;
    }
    if (sub === 'validate') {
      printValidation(out, await api.validateArtifact(requireFlag(flags, 'artifact'))); return 0;
    }
    if (sub === 'publish') {
      const result = await api.publishArtifact(requireFlag(flags, 'artifact'), {
        published_by: requireFlag(flags, 'by'), reason: requireFlag(flags, 'reason'),
      });
      print(out, result.artifact); printValidation(out, result.validation); return 0;
    }
    if (sub === 'retire') {
      print(out, await api.retireArtifact(requireFlag(flags, 'artifact'), {
        retired_by: requireFlag(flags, 'by'), reason: requireFlag(flags, 'reason'),
      })); return 0;
    }
    if (sub === 'doc') {
      const id = requireFlag(flags, 'artifact');
      out(`${resolveCenterUrl()}${API_PREFIX}/artifacts/${encodeURIComponent(id)}/document`); return 0;
    }
    err(`用法：${meta.usage}`); return 1;
  } catch (error) { printError(error, err); return 1; }
}
