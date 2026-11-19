// git 只读读取器：只执行 log / branch / rev-parse，绝不引入 fetch、pull、checkout、commit。
// 参数以数组传给 execFile，不拼 shell 字符串；所有失败映射为可读错误码。

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { codedError } from '../db/json.mjs';

const run = promisify(execFile);

const TIMEOUT_MS = 10_000;
const MAX_BUFFER = 16 * 1024 * 1024;
const FIELD = '\u001f';

/** 执行一条只读 git 命令，把失败翻译成稳定错误码。 */
async function git(cwd, args) {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw codedError('GIT_UNAVAILABLE', '未安装 git 或不在 PATH 中', 503);
    }
    if (error?.killed || error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT') {
      throw codedError('GIT_TIMEOUT', `git ${args[0]} 超时`, 504);
    }
    const stderr = String(error?.stderr || error?.message || '').trim();
    throw codedError('GIT_COMMAND_FAILED', `git ${args[0]} 执行失败：${stderr.slice(0, 300)}`, 502);
  }
}

/** 路径存在且是 git 工作区；否则抛出对应 400。 */
export async function isGitRepo(targetPath) {
  if (!targetPath) throw codedError('REPOSITORY_PATH_MISSING', '缺少本地路径', 400);
  if (!fs.existsSync(targetPath)) {
    throw codedError('REPOSITORY_PATH_MISSING', `路径不存在：${targetPath}`, 400);
  }
  let stdout;
  try {
    stdout = await git(targetPath, ['rev-parse', '--is-inside-work-tree']);
  } catch (error) {
    const message = String(error?.message || '');
    if (/not a git repository/i.test(message)) {
      throw codedError('REPOSITORY_NOT_GIT', `不是 git 仓库：${targetPath}`, 400);
    }
    throw error;
  }
  if (stdout.trim() !== 'true') {
    throw codedError('REPOSITORY_NOT_GIT', `不是 git 工作区：${targetPath}`, 400);
  }
  return true;
}

/** 列出本地分支名。 */
export async function readBranches({ path }) {
  await isGitRepo(path);
  const stdout = await git(path, ['branch', '--format=%(refname:short)']);
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * 读取提交历史。
 * @returns {Promise<Array<{sha, author_name, author_email, committed_at, subject, files_changed}>>}
 */
export async function readCommits({ path, branch = 'HEAD', limit = 200, since } = {}) {
  await isGitRepo(path);
  const max = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const args = ['log', String(branch || 'HEAD'), `--max-count=${max}`];
  if (since) args.push(`--since=${since}`);
  args.push(`--pretty=format:%H${FIELD}%an${FIELD}%ae${FIELD}%cI${FIELD}%s`, '--name-only');

  const stdout = await git(path, args);
  const commits = [];
  let current = null;

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;

    if (line.includes(FIELD)) {
      const [sha, author, email, committedAt, ...rest] = line.split(FIELD);
      current = {
        sha: sha?.trim(),
        author_name: author?.trim() ?? '',
        author_email: email?.trim() ?? '',
        committed_at: committedAt?.trim() ?? '',
        subject: rest.join(FIELD).trim(),
        files_changed: [],
      };
      if (current.sha) commits.push(current);
      continue;
    }
    // 提交头之后的行是该提交改动的文件。
    if (current) current.files_changed.push(line.trim());
  }

  return commits;
}
