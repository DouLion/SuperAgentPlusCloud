// 轻量参数解析：支持 --key value 与 --key=value，其余视为位置参数。
// 不引入第三方依赖；命令只关心自身需要的旗标。

/**
 * @param {string[]} argv
 * @returns {{ flags: Record<string, string|boolean>, positionals: string[] }}
 */
export function parseArgs(argv) {
  const flags = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }

    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[body] = true;
    } else {
      flags[body] = next;
      i += 1;
    }
  }

  return { flags, positionals };
}

/** 读取必填旗标；缺失或未带值时抛出带中文说明的错误。 */
export function requireFlag(flags, name, placeholder = '<值>') {
  const value = flags[name];
  if (value === undefined || value === true || value === '') {
    throw new Error(`缺少 --${name} ${placeholder}`);
  }
  return value;
}

/** 读取可选旗标；未给出返回 undefined。 */
export function optionalFlag(flags, name) {
  const value = flags[name];
  if (value === undefined || value === true || value === '') return undefined;
  return value;
}
