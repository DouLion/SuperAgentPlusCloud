// Client 骨架测试：帮助文本与命令清单一致性。
// 运行：node --test client/test/

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHelp, PLANNED_COMMANDS, DEFAULT_CENTER_URL } from '../src/help.mjs';

test('帮助包含全部已规划命令', () => {
  const help = buildHelp();
  for (const cmd of PLANNED_COMMANDS) {
    assert.ok(help.includes(cmd.name), `帮助缺少命令：${cmd.name}`);
    assert.ok(help.includes(cmd.desc), `帮助缺少说明：${cmd.name}`);
  }
});

test('帮助包含默认 Center 地址，且可被 CENTER_URL 覆盖', () => {
  assert.ok(buildHelp().includes(DEFAULT_CENTER_URL));
  const custom = buildHelp('http://127.0.0.1:9999');
  assert.ok(custom.includes('http://127.0.0.1:9999'));
  assert.ok(!custom.includes(DEFAULT_CENTER_URL));
});

test('命令清单非空且名称唯一', () => {
  assert.ok(PLANNED_COMMANDS.length >= 8);
  const names = PLANNED_COMMANDS.map((cmd) => cmd.name);
  assert.equal(new Set(names).size, names.length);
});
