// Center 存储层测试（T1）。
// 运行：node --test center/test/  或  npm test（center 目录下）
// 测试数据库使用系统临时目录，结束后删除。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openStore,
  migrate,
  reset,
  createTrunkItem,
  listTrunkItems,
  getTrunkItem,
  updateTrunkItemStatus,
  appendEvent,
  listEvents,
} from '../src/store.mjs';

const dbPath = path.join(
  os.tmpdir(),
  `sap-center-test-${process.pid}-${Date.now()}.db`,
);

let db;

test.before(() => {
  db = openStore(dbPath);
});

test.after(() => {
  db.close();
  fs.rmSync(dbPath, { force: true });
});

test('migrate 幂等：重复执行不报错且表齐全', () => {
  assert.doesNotThrow(() => {
    migrate(db);
    migrate(db);
  });

  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  const names = rows.map((row) => row.name);

  for (const table of [
    'projects',
    'trunk_items',
    'requirements',
    'assessments',
    'decisions',
    'tasks',
    'claims',
    'submissions',
    'reviews',
    'trunk_changes',
    'impact_items',
    'events',
  ]) {
    assert.ok(names.includes(table), `缺少表：${table}`);
  }
});

test('创建并查询主干条目：JSON 字段往返一致', () => {
  const project = db
    .prepare(
      'INSERT INTO projects (project_id, name, status, created_at) VALUES (?, ?, ?, ?)',
    )
    .run('proj_t1', 'T1 演示项目', 'active', new Date().toISOString());

  const relations = [{ type: 'depends_on', item_id: 'item_other' }];
  const sourceRefs = ['docs/03_总体架构.md', 'meeting/2026-11-18'];

  const created = createTrunkItem(db, {
    project_id: 'proj_t1',
    kind: 'goal',
    statement: '一期跑通需求到评审链路',
    rationale: '验证记录成本与流程可行性',
    relations,
    source_refs: sourceRefs,
    created_by: 'tester',
  });

  assert.match(created.item_id, /^item_/);
  assert.equal(created.status, 'proposed');
  assert.deepEqual(created.relations, relations);
  assert.deepEqual(created.source_refs, sourceRefs);

  const fetched = getTrunkItem(db, created.item_id);
  assert.equal(fetched.statement, '一期跑通需求到评审链路');
  assert.deepEqual(fetched.relations, relations);

  const list = listTrunkItems(db, { projectId: 'proj_t1' });
  assert.equal(list.length, 1);

  const activeOnly = listTrunkItems(db, {
    projectId: 'proj_t1',
    status: 'active',
  });
  assert.equal(activeOnly.length, 0);

  assert.equal(getTrunkItem(db, 'item_not_exist'), null);
});

test('状态更新：确认并补充生效信息', () => {
  const item = createTrunkItem(db, {
    project_id: 'proj_t1',
    kind: 'scope',
    statement: '只覆盖单项目',
  });

  const updated = updateTrunkItemStatus(db, item.item_id, 'active', {
    confirmed_by: 'alice',
    valid_from: '2026-11-18T00:00:00.000Z',
    source_refs: ['decision/001'],
  });

  assert.equal(updated.status, 'active');
  assert.equal(updated.confirmed_by, 'alice');
  assert.equal(updated.valid_from, '2026-11-18T00:00:00.000Z');
  assert.deepEqual(updated.source_refs, ['decision/001']);

  const retired = updateTrunkItemStatus(db, item.item_id, 'superseded', {
    superseded_by: 'item_new_one',
    valid_until: '2026-12-01T00:00:00.000Z',
  });
  assert.equal(retired.status, 'superseded');
  assert.equal(retired.superseded_by, 'item_new_one');

  assert.throws(
    () => updateTrunkItemStatus(db, item.item_id, 'bogus'),
    /非法的主干条目状态/,
  );
  assert.throws(
    () => updateTrunkItemStatus(db, 'item_missing', 'active'),
    /不存在/,
  );
});

test('事件追加与查询：可过滤、refs 可解析', () => {
  const event = appendEvent(db, {
    project_id: 'proj_t1',
    object_type: 'trunk_item',
    object_id: 'item_demo',
    event_type: 'trunk_item.proposed',
    actor: 'tester',
    reason: '测试事件',
    refs: ['docs/04_详细方案.md'],
  });

  assert.match(event.event_id, /^evt_/);
  assert.equal(event.event_type, 'trunk_item.proposed');
  assert.deepEqual(event.refs, ['docs/04_详细方案.md']);
  assert.ok(event.occurred_at <= event.recorded_at);

  const all = listEvents(db, { projectId: 'proj_t1' });
  assert.ok(all.length >= 1);

  const filtered = listEvents(db, {
    projectId: 'proj_t1',
    objectType: 'trunk_item',
    eventType: 'trunk_item.proposed',
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].event_id, event.event_id);

  assert.throws(
    () => appendEvent(db, { project_id: 'proj_t1' }),
    /缺少必填字段：event_type/,
  );
});

test('重置后表为空，且可再次迁移', () => {
  reset(db);

  const tables = ['projects', 'trunk_items', 'requirements', 'events'];
  for (const table of tables) {
    const { n } = db
      .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
      .get();
    assert.equal(n, 0, `${table} 未清空`);
  }

  assert.doesNotThrow(() => migrate(db));
});
