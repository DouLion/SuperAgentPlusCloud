// sap workflow：编排模板 CRUD、激活、退役与内置模板 seed。

import fs from 'node:fs';
import { api } from '../api.mjs';
import { parseArgs, requireFlag, optionalFlag } from '../args.mjs';
import { printError } from '../format.mjs';

export const meta = { name: 'workflow', usage: 'sap workflow list|show|create|activate|retire|seed ...' };
function jsonFile(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function print(out, row) {
  out(`${row.template_id}  ${row.name}  ${row.kind}  v${row.version}  ${row.status}${row.built_in ? ' [built-in]' : ''}`);
  for (const node of row.nodes || []) out(`  - ${node.key}: ${node.title} <- [${node.depends_on.join(', ')}]`);
}
export async function run(argv, io = {}) {
  const out = io.stdout || console.log;
  const err = io.stderr || console.error;
  const [sub, ...rest] = argv;
  const { flags } = parseArgs(rest);
  try {
    if (sub === 'list') {
      const rows = await api.listWorkflowTemplates({
        project_id: optionalFlag(flags, 'project'), status: optionalFlag(flags, 'status'), kind: optionalFlag(flags, 'kind'),
      }); rows.forEach((row) => print(out, row)); return 0;
    }
    if (sub === 'show') { print(out, await api.getWorkflowTemplate(requireFlag(flags, 'template'))); return 0; }
    if (sub === 'create') {
      const body = jsonFile(requireFlag(flags, 'file'));
      Object.assign(body, {
        name: optionalFlag(flags, 'name') ?? body.name,
        kind: optionalFlag(flags, 'kind') ?? body.kind,
        project_id: optionalFlag(flags, 'project') ?? body.project_id,
        created_by: optionalFlag(flags, 'by') ?? body.created_by,
      }); print(out, await api.createWorkflowTemplate(body)); return 0;
    }
    if (sub === 'activate') {
      print(out, await api.activateWorkflowTemplate(requireFlag(flags, 'template'), { activated_by: requireFlag(flags, 'by') })); return 0;
    }
    if (sub === 'retire') {
      print(out, await api.retireWorkflowTemplate(requireFlag(flags, 'template'), { retired_by: requireFlag(flags, 'by') })); return 0;
    }
    if (sub === 'seed') { print(out, await api.seedWorkflowTemplates({ created_by: optionalFlag(flags, 'by') })); return 0; }
    err(`用法：${meta.usage}`); return 1;
  } catch (error) { printError(error, err); return 1; }
}
