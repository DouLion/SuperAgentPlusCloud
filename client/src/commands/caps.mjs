// sap caps：主体能力设置与查看（P4）。能力只影响候选人推荐。

import { api } from '../api.mjs';
import { optionalFlag, parseArgs, requireFlag } from '../args.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'caps',
  usage: 'sap caps set --actor <id> --key <能力> --level basic|standard|expert ｜ sap caps list --actor <id>',
};

export async function run(argv, io = {}) {
  const out = io.stdout || console.log;
  const err = io.stderr || console.error;
  const [sub, ...rest] = argv;
  const { flags } = parseArgs(rest);

  try {
    if (sub === 'set') {
      const actorId = requireFlag(flags, 'actor');
      const saved = await api.setCapability(actorId, {
        key: requireFlag(flags, 'key'),
        level: optionalFlag(flags, 'level') ?? 'standard',
      });
      out(`${saved.actor_id}  ${saved.key} = ${saved.level}`);
      return 0;
    }

    if (sub === 'list') {
      const rows = await api.listCapabilities(requireFlag(flags, 'actor'));
      if (rows.length === 0) {
        out('该主体还没有登记能力');
        return 0;
      }
      rows.forEach((row) => out(`${row.key}\t${row.level}\t${row.updated_at}`));
      return 0;
    }

    err(`用法：${meta.usage}`);
    return 1;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}
