// sap subscribe：outbox webhook 订阅（G 枝）。订阅只影响投递，不改变业务状态。

import { api } from '../api.mjs';
import { collectFlagValues, parseArgs, requireFlag } from '../args.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'subscribe',
  usage: 'sap subscribe add --url http://... [--topic <topic> ...] [--secret <密钥>] ｜ '
    + 'sap subscribe list [--include-disabled] ｜ sap subscribe remove --id <subscription_id>',
};

export async function run(argv, io = {}) {
  const out = io.stdout || console.log;
  const err = io.stderr || console.error;
  const [sub, ...rest] = argv;
  const { flags } = parseArgs(rest);
  const options = { url: io.url, env: io.env, fetchImpl: io.fetchImpl };

  try {
    if (sub === 'add') {
      const created = await api.createSubscription({
        url: requireFlag(flags, 'url'),
        topics: collectFlagValues(rest, 'topic'),
        secret: flags.secret,
      }, options);
      out(`订阅已创建：${created.subscription_id}`);
      out(`  url：${created.url}`);
      out(`  topics：${created.topics.length ? created.topics.join(',') : '(全部)'}`);
      out(`  签名：${created.secret ? '已启用 HMAC-SHA256' : '未启用'}`);
      return 0;
    }

    if (sub === 'list') {
      const rows = await api.listSubscriptions({ include_disabled: flags['include-disabled'] ? 'true' : undefined }, options);
      if (!rows.length) {
        out('还没有订阅');
        return 0;
      }
      rows.forEach((row) => out(
        `${row.subscription_id}  ${row.url}  topics=${row.topics.length ? row.topics.join(',') : '(全部)'}`
        + `${row.disabled_at ? `  已停用@${row.disabled_at}` : ''}`,
      ));
      return 0;
    }

    if (sub === 'remove') {
      const disabled = await api.deleteSubscription(requireFlag(flags, 'id'), options);
      out(`订阅已停用：${disabled.subscription_id}`);
      return 0;
    }

    err(`用法：${meta.usage}`);
    return 1;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}
