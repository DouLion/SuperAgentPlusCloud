// sap actor：主体、凭据管理（P1）。
// 首次引导：系统没有任何主体时可直接创建；之后需要人类 token。

import { api } from '../api.mjs';
import { parseArgs, requireFlag, optionalFlag } from '../args.mjs';
import { printError, line } from '../format.mjs';

export const meta = {
  name: 'actor',
  usage: 'sap actor create|list|show|disable|token|revoke-token ...',
};

function print(out, actor) {
  out(`${actor.actor_id}  ${actor.type}  ${actor.display_name}  ${actor.status}`);
}

export async function run(argv, io = {}) {
  const out = io.stdout || console.log;
  const err = io.stderr || console.error;
  const [sub, ...rest] = argv;
  const { flags } = parseArgs(rest);

  try {
    if (sub === 'create') {
      const type = requireFlag(flags, 'type', '<human|agent|service>');
      const body = {
        type,
        display_name: requireFlag(flags, 'name', '<名称>'),
        created_by: optionalFlag(flags, 'by'),
      };
      if (type === 'agent') body.on_behalf_of = requireFlag(flags, 'owner', '<人类 actor_id>');
      if (flags.project) body.project_id = optionalFlag(flags, 'project');
      if (flags.actions) body.allowed_actions = flags.actions.split(',').map((item) => item.trim()).filter(Boolean);
      print(out, await api.createActor(body));
      return 0;
    }

    if (sub === 'list') {
      const rows = await api.listActors({
        type: optionalFlag(flags, 'type'), status: optionalFlag(flags, 'status'),
      });
      if (rows.length === 0) out('（暂无主体）');
      rows.forEach((row) => print(out, row));
      return 0;
    }

    if (sub === 'show') {
      const actor = await api.getActor(requireFlag(flags, 'actor', '<actor_id>'));
      print(out, actor);
      line(out, '创建时间', actor.created_at);
      line(out, '创建者', actor.created_by);
      return 0;
    }

    if (sub === 'disable') {
      print(out, await api.disableActor(requireFlag(flags, 'actor', '<actor_id>'), {
        reason: optionalFlag(flags, 'reason') ?? '停用主体',
      }));
      return 0;
    }

    if (sub === 'token') {
      // 注意：token 明文只在这里出现一次，服务端只存哈希。
      const result = await api.issueCredential(requireFlag(flags, 'actor', '<actor_id>'), {
        label: optionalFlag(flags, 'label'),
        expires_at: optionalFlag(flags, 'expires-at'),
      });
      out(`已签发凭据：${result.credential.credential_id}`);
      out(`token（只显示一次，请立即保存）：${result.token}`);
      return 0;
    }

    if (sub === 'revoke-token') {
      const result = await api.revokeCredential(requireFlag(flags, 'credential', '<credential_id>'));
      out(`凭据已撤销：${result.credential_id}`);
      return 0;
    }

    err(`用法：${meta.usage}`);
    return 1;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}
