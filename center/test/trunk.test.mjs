// Center 主干条目确认与退役测试（T6）。
// 运行：node --test center/test/
// 测试数据库使用系统临时目录，结束后删除。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openStore,
  createProject,
  createTrunkItem,
  getTrunkItem,
  listTrunkItems,
  confirmTrunkItem,
  retireTrunkItem,
  listEvents,
} from '../src/store.mjs';
import { createServer } from '../src/server.mjs';

const dbPath = path.join(
  os.tmpdir(),
  `sap-center-trunk-test-${process.pid}-${Date.now()}.db`,
);

let db;

test.before(() => {
  db = openStore(dbPath);
});

test.after(() => {
  db.close();
  fs.rmSync(dbPath, { force: true });
});

/** 建一个项目与一个 proposed 主干条目。 */
function seedProposed() {
  const project = createProject(db, { name: 'T6 主干项目' });
  const item = createTrunkItem(db, {
    project_id: project.project_id,
    kind: 'scope',
    statement: '只覆盖单项目',
    rationale: '一期范围',
    source_refs: ['docs/04_详细方案.md'],
  });
  return { project, item };
}

test('确认：proposed → active，写 confirmed_at/confirmed_by 与 valid_from，并写事件', () => {
  const { project, item } = seedProposed();

  assert.throws(
    () => confirmTrunkItem(db, item.item_id, {}),
    /缺少必填字段：confirmed_by/,
  );
  assert.throws(
    () => confirmTrunkItem(db, 'item_missing', { confirmed_by: 'owner' }),
    /主干条目不存在/,
  );

  const confirmed = confirmTrunkItem(db, item.item_id, {
    confirmed_by: 'owner_a',
    valid_from: '2026-11-19T00:00:00.000Z',
  });
  assert.equal(confirmed.status, 'active');
  assert.equal(confirmed.confirmed_by, 'owner_a');
  assert.equal(confirmed.valid_from, '2026-11-19T00:00:00.000Z');
  assert.ok(confirmed.confirmed_at);
  assert.equal(getTrunkItem(db, item.item_id).status, 'active');
  assert.deepEqual(
    listTrunkItems(db, { projectId: project.project_id, status: 'active' })
      .map((row) => row.item_id),
    [item.item_id],
  );

  const events = listEvents(db, {
    projectId: project.project_id,
    event_type: 'trunk_item.confirmed',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].object_id, item.item_id);
  assert.equal(events[0].actor, 'owner_a');
});

test('确认：未给 valid_from 时保留原值；重复确认非法流转', () => {
  const { item } = seedProposed();
  const withValidFrom = createTrunkItem(db, {
    project_id: item.project_id,
    kind: 'goal',
    statement: '已有生效时间',
    valid_from: '2026-11-01T00:00:00.000Z',
  });

  const confirmed = confirmTrunkItem(db, withValidFrom.item_id, { confirmed_by: 'owner_b' });
  assert.equal(confirmed.valid_from, '2026-11-01T00:00:00.000Z');

  // 对 active 再 confirm → INVALID_TRANSITION / 409。
  confirmTrunkItem(db, item.item_id, { confirmed_by: 'owner_a' });
  assert.throws(
    () => confirmTrunkItem(db, item.item_id, { confirmed_by: 'owner_a' }),
    (error) => {
      assert.equal(error.code, 'INVALID_TRANSITION');
      assert.equal(error.status, 409);
      assert.match(error.message, /不可确认/);
      return true;
    },
  );
  // 已确认的条目同样不可再确认。
  assert.throws(
    () => confirmTrunkItem(db, withValidFrom.item_id, { confirmed_by: 'owner_b' }),
    /INVALID_TRANSITION|不可确认/,
  );
});

test('退役：active → retired，写事件；proposed/retired 不可退役', () => {
  const { project, item } = seedProposed();
  assert.throws(
    () => retireTrunkItem(db, item.item_id, { confirmed_by: 'owner_a' }),
    (error) => {
      assert.equal(error.code, 'INVALID_TRANSITION');
      assert.equal(error.status, 409);
      return true;
    },
  );
  assert.throws(
    () => retireTrunkItem(db, 'item_missing', { confirmed_by: 'owner_a' }),
    /主干条目不存在/,
  );

  // active 条目缺 confirmed_by 时先报缺少必填字段。
  confirmTrunkItem(db, item.item_id, { confirmed_by: 'owner_a' });
  assert.throws(
    () => retireTrunkItem(db, item.item_id, {}),
    /缺少必填字段：confirmed_by/,
  );

  const retired = retireTrunkItem(db, item.item_id, { confirmed_by: 'owner_b' });
  assert.equal(retired.status, 'retired');
  // 退役不覆盖首次确认痕迹。
  assert.equal(retired.confirmed_by, 'owner_a');
  assert.equal(getTrunkItem(db, item.item_id).status, 'retired');

  const events = listEvents(db, {
    projectId: project.project_id,
    event_type: 'trunk_item.retired',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].object_id, item.item_id);
  assert.equal(events[0].actor, 'owner_b');

  // 已退役不可再次退役，也不可再确认。
  assert.throws(
    () => retireTrunkItem(db, item.item_id, { confirmed_by: 'owner_b' }),
    /INVALID_TRANSITION|不可退役/,
  );
  assert.throws(
    () => confirmTrunkItem(db, item.item_id, { confirmed_by: 'owner_a' }),
    /INVALID_TRANSITION|不可确认/,
  );
});

test('HTTP：trunk-items 查询、确认、退役路由与状态码', async () => {
  const { project } = seedProposed();
  const proposed = listTrunkItems(db, { projectId: project.project_id })[0];

  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/sap-cloud/api`;

  try {
    const fetched = await fetch(`${base}/trunk-items/${proposed.item_id}`)
      .then((res) => res.json());
    assert.equal(fetched.item_id, proposed.item_id);
    assert.equal(fetched.status, 'proposed');

    const missing = await fetch(`${base}/trunk-items/item_missing`);
    assert.equal(missing.status, 404);

    const confirmed = await fetch(`${base}/trunk-items/${proposed.item_id}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmed_by: 'owner_http', valid_from: '2026-11-20T00:00:00.000Z' }),
    }).then((res) => res.json());
    assert.equal(confirmed.status, 'active');
    assert.equal(confirmed.valid_from, '2026-11-20T00:00:00.000Z');

    const conflict = await fetch(`${base}/trunk-items/${proposed.item_id}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmed_by: 'owner_http' }),
    });
    assert.equal(conflict.status, 409);
    const conflictBody = await conflict.json();
    assert.equal(conflictBody.code, 'INVALID_TRANSITION');

    const retired = await fetch(`${base}/trunk-items/${proposed.item_id}/retire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmed_by: 'owner_http' }),
    }).then((res) => res.json());
    assert.equal(retired.status, 'retired');

    const retireConflict = await fetch(`${base}/trunk-items/${proposed.item_id}/retire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmed_by: 'owner_http' }),
    });
    assert.equal(retireConflict.status, 409);
    assert.equal((await retireConflict.json()).code, 'INVALID_TRANSITION');

    const missingConfirm = await fetch(`${base}/trunk-items/item_missing/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmed_by: 'owner_http' }),
    });
    assert.equal(missingConfirm.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
