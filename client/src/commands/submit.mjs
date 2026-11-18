// sap submit：提交需求或问题，保留原文与来源引用。

import { api } from '../api.mjs';
import { parseArgs, requireFlag, optionalFlag } from '../args.mjs';
import { LEVELS } from '../limits.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'submit',
  usage: 'sap submit --project <id> --text <原文> [--level L0..L4] [--reason ...] [--source ...] [--author <名字>]',
};

/**
 * @param {string[]} argv
 * @param {object} [io] { stdout, stderr }
 * @returns {Promise<number>} 退出码
 */
export async function run(argv, io = {}) {
  const out = io.stdout || ((line) => console.log(line));
  const err = io.stderr || ((line) => console.error(line));

  const { flags } = parseArgs(argv);
  let projectId;
  let text;
  try {
    projectId = requireFlag(flags, 'project', '<id>');
    text = requireFlag(flags, 'text', '<原文>');
  } catch (error) {
    printError(error, err);
    err(`用法：${meta.usage}`);
    return 1;
  }

  const level = optionalFlag(flags, 'level');
  if (level !== undefined && !LEVELS.includes(level)) {
    err(`--level 只能是 ${LEVELS.join(' / ')}，当前为：${level}`);
    return 1;
  }

  try {
    const requirement = await api.createRequirement({
      project_id: projectId,
      raw_text: text,
      claimed_level: level,
      claimed_reason: optionalFlag(flags, 'reason'),
      source_ref: optionalFlag(flags, 'source'),
      author: optionalFlag(flags, 'author'),
    });

    out(`需求已提交：${requirement.requirement_id}`);
    out(`项目：${requirement.project_id}　状态：${requirement.status}`);
    if (requirement.claimed_level) out(`自报等级：${requirement.claimed_level}`);
    return 0;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}
