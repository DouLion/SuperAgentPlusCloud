// sap convention：约定包 CRUD、激活、退役与团队模板导入。

import fs from 'node:fs';
import { api } from '../api.mjs';
import { parseArgs, requireFlag, optionalFlag } from '../args.mjs';
import { printError } from '../format.mjs';

export const meta = { name: 'convention', usage: 'sap convention list|show|create|activate|retire|import ...' };

function jsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function print(out, pack) {
  out(`${pack.pack_id}  ${pack.name}  ${pack.scope}  v${pack.version}  ${pack.status}`);
  for (const rule of pack.rules || []) out(`  - [${rule.severity}] ${rule.key}: ${rule.title}`);
}

export async function run(argv, io = {}) {
  const out = io.stdout || console.log;
  const err = io.stderr || console.error;
  const [sub, ...rest] = argv;
  const { flags } = parseArgs(rest);
  try {
    if (sub === 'list') {
      const rows = await api.listConventionPacks({
        project_id: optionalFlag(flags, 'project'), scope: optionalFlag(flags, 'scope'), status: optionalFlag(flags, 'status'),
      });
      rows.forEach((row) => print(out, row)); return 0;
    }
    if (sub === 'show') { print(out, await api.getConventionPack(requireFlag(flags, 'pack'))); return 0; }
    if (sub === 'create') {
      const body = jsonFile(requireFlag(flags, 'file'));
      Object.assign(body, {
        name: optionalFlag(flags, 'name') ?? body.name,
        scope: optionalFlag(flags, 'scope') ?? body.scope,
        project_id: optionalFlag(flags, 'project') ?? body.project_id,
        created_by: optionalFlag(flags, 'by') ?? body.created_by,
      });
      print(out, await api.createConventionPack(body)); return 0;
    }
    if (sub === 'activate') {
      print(out, await api.activateConventionPack(requireFlag(flags, 'pack'), {
        activated_by: requireFlag(flags, 'by'), reason: requireFlag(flags, 'reason'),
      })); return 0;
    }
    if (sub === 'retire') {
      print(out, await api.retireConventionPack(requireFlag(flags, 'pack'), {
        retired_by: requireFlag(flags, 'by'), reason: requireFlag(flags, 'reason'),
      })); return 0;
    }
    if (sub === 'import') {
      print(out, await api.importConventionPack(requireFlag(flags, 'pack'), {
        project_id: requireFlag(flags, 'project'), created_by: optionalFlag(flags, 'by'), name: optionalFlag(flags, 'name'),
      })); return 0;
    }
    err(`用法：${meta.usage}`); return 1;
  } catch (error) { printError(error, err); return 1; }
}
