// sap repo：项目代码仓库。一个项目可登记多个 git 地址，提交事实按仓库归属。

import { api } from '../api.mjs';
import { optionalFlag, parseArgs, requireFlag } from '../args.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'repo',
  usage: 'sap repo add --project <id> --name <名称> --url <git 地址> [--branch <默认分支>] [--provider github|gitlab|gitee|azure|other]\n'
    + '       sap repo list --project <id> [--status active|archived]\n'
    + '       sap repo show --repo <repository_id>\n'
    + '       sap repo archive --repo <repository_id> [--reason <理由>]\n'
    + '       sap repo commits --repo <repository_id> [--limit N]',
};

function printRepository(out, repo) {
  out(`${repo.repository_id}  ${repo.name}  ${repo.status === 'archived' ? '[已归档]' : ''}`);
  out(`  地址：${repo.url}`);
  out(`  服务商：${repo.provider}  默认分支：${repo.default_branch || '—'}`);
  if (repo.commit_count !== undefined) {
    out(`  提交事实：${repo.commit_count}  最近：${repo.last_commit_at || '—'}`);
    if (repo.refs?.length) out(`  分支：${repo.refs.join(', ')}`);
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
      const repo = await api.createRepository(requireFlag(flags, 'project'), {
        name: requireFlag(flags, 'name'),
        url: requireFlag(flags, 'url'),
        default_branch: optionalFlag(flags, 'branch'),
        provider: optionalFlag(flags, 'provider'),
      }, options);
      out(`仓库已登记：${repo.repository_id}`);
      printRepository(out, repo);
      return 0;
    }

    if (sub === 'list') {
      const rows = await api.listRepositories(
        requireFlag(flags, 'project'),
        { status: optionalFlag(flags, 'status'), summary: '1' },
        options,
      );
      if (!rows.length) {
        out('该项目还没有登记仓库');
        return 0;
      }
      rows.forEach((row) => printRepository(out, row));
      return 0;
    }

    if (sub === 'show') {
      printRepository(out, await api.getRepository(requireFlag(flags, 'repo'), options));
      return 0;
    }

    if (sub === 'archive') {
      const repo = await api.archiveRepository(requireFlag(flags, 'repo'), {
        reason: optionalFlag(flags, 'reason'),
      }, options);
      out(`仓库已归档：${repo.repository_id}  历史提交事实保留`);
      return 0;
    }

    if (sub === 'commits') {
      const result = await api.listRepositoryFacts(
        requireFlag(flags, 'repo'),
        { source: 'git', kind: 'commit', limit: optionalFlag(flags, 'limit') ?? 20 },
        options,
      );
      if (!result.facts.length) {
        out('该仓库还没有提交事实');
        return 0;
      }
      for (const fact of result.facts) {
        const payload = fact.payload || {};
        out(`${String(payload.commit_sha || fact.external_id).slice(0, 12)}  ${payload.ref || '—'}  `
          + `${String(payload.message || payload.summary || '').slice(0, 80)}  ${fact.received_at}`);
      }
      return 0;
    }

    err(`用法：${meta.usage}`);
    return 1;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}
