// Center 主干变更与影响处置测试（T5）。
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
  createRequirement,
  createTrunkItem,
  getTrunkItem,
  updateTrunkItemStatus,
  createTrunkChange,
  getTrunkChange,
  listTrunkChanges,
  confirmTrunkChange,
  activateTrunkChange,
  closeTrunkChange,
  addImpactItem,
  updateImpactItem,
  listImpactItems,
  getImpactItem,
  listEvents,
} from '../src/store.mjs';
import { createServer } from '../src/server.mjs';

const dbPath = path.join(
  os.tmpdir(),
  `sap-center-change-test-${process.pid}-${Date.now()}.db`,
);

let db;

test.before(() => {
  db = openStore(dbPath);
});

test.after(() => {
  db.close();
  fs.rmSync(dbPath, { force: true });
});

/** 建一个项目，返回 project。 */
function seed() {
  return createProject(db, { name: 'T5 变更项目' });
}

/** 建一个 active 主干条目。 */
function activeItem(projectId, statement, kind = 'scope') {
  return createTrunkItem(db, {
    project_id: projectId,
    kind,
    statement,
    status: 'active',
    confirmed_by: 'owner_a',
    confirmed_at: '2026-11-18T00:00:00.000Z',
  });
}

/** 建变更并走完 propose → confirm → activate，返回 { change, oldItem, newItem }。 */
function seedEffectiveChange(overrides = {}) {
  const project = seed();
  const oldItem = activeItem(project.project_id, '旧范围：仅内部使用');
  const change = createTrunkChange(db, {
    project_id: project.project_id,
    reason: '范围调整',
    old_item_ids: [oldItem.item_id],
    proposed_items: [{ kind: 'scope', statement: '新范围：对外开放' }],
    ...overrides,
  });
  const newItem = getTrunkItem(db, change.proposed_item_ids[0]);
  confirmTrunkChange(db, change.change_id, { confirmed_by: 'owner_b' });
  activateTrunkChange(db, change.change_id, { confirmed_by: 'owner_b' });
  return {
    project,
    change: getTrunkChange(db, change.change_id),
    oldItem: getTrunkItem(db, oldItem.item_id),
    newItem: getTrunkItem(db, newItem.item_id),
  };
}

test('变更：必填校验、默认 proposed、proposed_items 生成 proposed 条目并写事件', () => {
  const project = seed();

  assert.throws(
    () => createTrunkChange(db, { reason: '缺少项目' }),
    /缺少必填字段：project_id/,
  );
  assert.throws(
    () => createTrunkChange(db, { project_id: project.project_id }),
    /缺少必填字段：reason/,
  );
  assert.throws(
    () => createTrunkChange(db, {
      project_id: project.project_id,
      reason: '非法条目类型',
      proposed_items: [{ kind: 'bogus', statement: 'x' }],
    }),
    /非法的主干条目类型/,
  );
  assert.throws(
    () => createTrunkChange(db, { project_id: 'prj_missing', reason: '不存在项目' }),
    /项目不存在/,
  );
  assert.throws(
    () => createTrunkChange(db, {
      project_id: project.project_id,
      reason: '触发需求不存在',
      trigger_requirement_id: 'req_missing',
    }),
    /需求不存在/,
  );

  const requirement = createRequirement(db, {
    project_id: project.project_id,
    raw_text: '希望调整主干范围',
  });

  const change = createTrunkChange(db, {
    project_id: project.project_id,
    reason: '旧范围已不适用',
    trigger_requirement_id: requirement.requirement_id,
    old_item_ids: [],
    impact_assessment: '初步判断仅影响范围说明',
    proposed_items: [{
      kind: 'scope',
      statement: '新范围：对外开放',
      rationale: '业务已对外提供服务',
      source_refs: ['docs/01_解决思路.md'],
    }],
    created_by: 'alice',
  });

  assert.match(change.change_id, /^chg_/);
  assert.equal(change.status, 'proposed');
  assert.equal(change.project_id, project.project_id);
  assert.equal(change.trigger_requirement_id, requirement.requirement_id);
  assert.deepEqual(change.old_item_ids, []);
  assert.equal(change.proposed_item_ids.length, 1);
  assert.equal(change.impact_assessment, '初步判断仅影响范围说明');
  assert.deepEqual(
    listTrunkChanges(db, { projectId: project.project_id }).map((c) => c.change_id),
    [change.change_id],
  );
  assert.equal(listTrunkChanges(db, { status: 'proposed' }).length, 1);
  assert.equal(listTrunkChanges(db, { status: 'closed' }).length, 0);
  assert.throws(() => listTrunkChanges(db, { status: 'bogus' }), /非法的主干变更状态/);
  assert.equal(getTrunkChange(db, 'chg_missing'), null);

  const proposed = getTrunkItem(db, change.proposed_item_ids[0]);
  assert.equal(proposed.status, 'proposed');
  assert.equal(proposed.project_id, project.project_id);
  assert.equal(proposed.statement, '新范围：对外开放');
  assert.equal(proposed.rationale, '业务已对外提供服务');
  assert.deepEqual(proposed.source_refs, ['docs/01_解决思路.md']);

  const events = listEvents(db, {
    projectId: project.project_id,
    event_type: 'change.proposed',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].object_id, change.change_id);
});

test('变更：proposed → confirmed → in_effect，旧条目 superseded 且指向新条目', () => {
  const project = seed();
  const oldItem = activeItem(project.project_id, '旧范围：仅内部使用');
  const change = createTrunkChange(db, {
    project_id: project.project_id,
    reason: '范围调整',
    old_item_ids: [oldItem.item_id],
    proposed_items: [{ kind: 'scope', statement: '新范围：对外开放' }],
  });
  const newItemId = change.proposed_item_ids[0];

  assert.throws(
    () => confirmTrunkChange(db, change.change_id, {}),
    /缺少必填字段：confirmed_by/,
  );

  const confirmed = confirmTrunkChange(db, change.change_id, {
    confirmed_by: 'owner_b',
    effective_at: '2026-11-19T00:00:00.000Z',
    policy_ref: '政策-2026-01',
  });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.confirmed_by, 'owner_b');
  assert.equal(confirmed.effective_at, '2026-11-19T00:00:00.000Z');
  assert.equal(confirmed.policy_ref, '政策-2026-01');
  assert.throws(
    () => confirmTrunkChange(db, change.change_id, { confirmed_by: 'owner_b' }),
    (error) => {
      assert.equal(error.code, 'INVALID_TRANSITION');
      assert.equal(error.status, 409);
      return true;
    },
  );

  const effective = activateTrunkChange(db, change.change_id, { confirmed_by: 'owner_b' });
  assert.equal(effective.status, 'in_effect');

  const newItem = getTrunkItem(db, newItemId);
  assert.equal(newItem.status, 'active');
  assert.equal(newItem.confirmed_by, 'owner_b');
  assert.equal(newItem.confirmed_at, '2026-11-19T00:00:00.000Z');

  const oldAfter = getTrunkItem(db, oldItem.item_id);
  assert.equal(oldAfter.status, 'superseded');
  assert.equal(oldAfter.superseded_by, newItemId);

  // 非法流转：proposed 直接 activate、confirmed 重复 activate。
  const project2 = seed();
  const old2 = activeItem(project2.project_id, '旧条目二');
  const change2 = createTrunkChange(db, {
    project_id: project2.project_id,
    reason: '非法流转演示',
    old_item_ids: [old2.item_id],
    proposed_items: [{ kind: 'scope', statement: '新条目二' }],
  });
  assert.throws(
    () => activateTrunkChange(db, change2.change_id, { confirmed_by: 'owner_b' }),
    /INVALID_TRANSITION|不可生效/,
  );
  confirmTrunkChange(db, change2.change_id, { confirmed_by: 'owner_b' });
  activateTrunkChange(db, change2.change_id, { confirmed_by: 'owner_b' });
  assert.throws(
    () => activateTrunkChange(db, change2.change_id, { confirmed_by: 'owner_b' }),
    /INVALID_TRANSITION|不可生效/,
  );
  assert.throws(
    () => activateTrunkChange(db, 'chg_missing', { confirmed_by: 'owner_b' }),
    /主干变更不存在/,
  );

  const types = listEvents(db, { projectId: project.project_id }).map((e) => e.event_type);
  for (const expected of ['change.proposed', 'change.confirmed', 'trunk_item.confirmed', 'trunk_item.superseded']) {
    assert.ok(types.includes(expected), `缺少事件：${expected}`);
  }
  // 确认与生效各写一次 change.confirmed。
  assert.equal(
    listEvents(db, {
      projectId: project.project_id,
      event_type: 'change.confirmed',
    }).length,
    2,
  );
  const superseded = listEvents(db, {
    projectId: project.project_id,
    event_type: 'trunk_item.superseded',
  });
  assert.equal(superseded.length, 1);
  assert.equal(superseded[0].object_id, oldItem.item_id);
  assert.ok(superseded[0].reason.includes(newItemId));
});

test('影响项：默认 to_check/pending，字段校验，not_affected 缺 reason 抛错', () => {
  const { project, change } = seedEffectiveChange();

  assert.throws(
    () => addImpactItem(db, { change_id: 'chg_missing', target_type: 'task', target_id: 'task_a' }),
    /主干变更不存在/,
  );
  assert.throws(
    () => addImpactItem(db, { change_id: change.change_id, target_type: 'bogus', target_id: 'x' }),
    /非法的影响对象类型/,
  );
  assert.throws(
    () => addImpactItem(db, { change_id: change.change_id, target_type: 'task' }),
    /缺少必填字段：target_id/,
  );

  const impact = addImpactItem(db, {
    change_id: change.change_id,
    target_type: 'task',
    target_id: 'task_a',
    owner_id: 'worker_a',
  });
  assert.match(impact.impact_item_id, /^imp_/);
  assert.equal(impact.assessment_status, 'to_check');
  assert.equal(impact.resolution, 'pending');
  assert.equal(impact.owner_id, 'worker_a');
  assert.equal(getImpactItem(db, impact.impact_item_id).target_id, 'task_a');
  assert.equal(getImpactItem(db, 'imp_missing'), null);
  assert.equal(listImpactItems(db, change.change_id).length, 1);

  const created = listEvents(db, {
    projectId: project.project_id,
    event_type: 'impact_item.created',
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].object_id, impact.impact_item_id);

  assert.throws(
    () => updateImpactItem(db, impact.impact_item_id, { assessment_status: 'bogus' }),
    /非法的影响评估状态/,
  );
  assert.throws(
    () => updateImpactItem(db, impact.impact_item_id, { resolution: 'bogus' }),
    /非法的影响处置方式/,
  );
  assert.throws(
    () => updateImpactItem(db, impact.impact_item_id, { assessment_status: 'not_affected' }),
    /not_affected 时必须提供 reason/,
  );
  assert.throws(
    () => updateImpactItem(db, 'imp_missing', { assessment_status: 'affected' }),
    /影响项不存在/,
  );

  const updated = updateImpactItem(db, impact.impact_item_id, {
    assessment_status: 'not_affected',
    resolution: 'continue',
    reason: '该任务不依赖被替代的范围',
  });
  assert.equal(updated.assessment_status, 'not_affected');
  assert.equal(updated.resolution, 'continue');
  assert.equal(updated.reason, '该任务不依赖被替代的范围');
  assert.ok(updated.updated_at);

  const updatedEvents = listEvents(db, {
    projectId: project.project_id,
    event_type: 'impact_item.updated',
  });
  assert.equal(updatedEvents.length, 1);
  assert.equal(updatedEvents[0].object_id, impact.impact_item_id);
});

test('关闭门槛：to_check 不能关闭，全部处置后可关闭并写事件', () => {
  const { project, change } = seedEffectiveChange();
  const impact = addImpactItem(db, {
    change_id: change.change_id,
    target_type: 'document',
    target_id: 'doc_a',
    owner_id: 'owner_c',
  });

  assert.throws(
    () => closeTrunkChange(db, change.change_id),
    (error) => {
      assert.equal(error.code, 'CHANGE_IMPACT_UNRESOLVED');
      assert.equal(error.status, 409);
      assert.match(error.message, /待检查/);
      return true;
    },
  );
  assert.equal(getTrunkChange(db, change.change_id).status, 'in_effect');

  // 仅改为 affected 仍不算处置完成？按规则只要不是 to_check 即可关闭；
  // 这里验证“待检查”与“已评估”确实区分：affected 也允许关闭。
  updateImpactItem(db, impact.impact_item_id, {
    assessment_status: 'affected',
    resolution: 'adjust',
    reason: '需要同步修改文档',
  });
  const closed = closeTrunkChange(db, change.change_id);
  assert.equal(closed.status, 'closed');

  const closedEvents = listEvents(db, {
    projectId: project.project_id,
    event_type: 'change.closed',
  });
  assert.equal(closedEvents.length, 1);
  assert.equal(closedEvents[0].object_id, change.change_id);

  assert.throws(
    () => closeTrunkChange(db, change.change_id),
    /INVALID_TRANSITION|不可关闭/,
  );
  assert.throws(
    () => closeTrunkChange(db, 'chg_missing'),
    /主干变更不存在/,
  );
});

test('关闭门槛：无影响项且无影响声明不能关闭；填写声明后可关闭', () => {
  const project = seed();

  // 无影响项、无声明：确认并生效后仍不能关闭。
  const change = createTrunkChange(db, {
    project_id: project.project_id,
    reason: '无影响声明演示',
  });
  confirmTrunkChange(db, change.change_id, { confirmed_by: 'owner_a' });
  activateTrunkChange(db, change.change_id, { confirmed_by: 'owner_a' });

  assert.throws(
    () => closeTrunkChange(db, change.change_id),
    (error) => {
      assert.equal(error.code, 'CHANGE_IMPACT_UNRESOLVED');
      assert.match(error.message, /影响声明/);
      return true;
    },
  );
  assert.equal(getTrunkChange(db, change.change_id).status, 'in_effect');

  // 明确声明“已检查，无影响对象”后可关闭。
  const declared = createTrunkChange(db, {
    project_id: project.project_id,
    reason: '已检查无影响',
    impact_assessment: '已逐项检查在途任务与文档，确认无受影响对象。',
  });
  confirmTrunkChange(db, declared.change_id, { confirmed_by: 'owner_a' });
  activateTrunkChange(db, declared.change_id, { confirmed_by: 'owner_a' });
  assert.equal(closeTrunkChange(db, declared.change_id).status, 'closed');

  // 确认后未到关闭条件前不能跳过 in_effect 直接关闭。
  const change3 = createTrunkChange(db, {
    project_id: project.project_id,
    reason: '不能越级关闭',
  });
  confirmTrunkChange(db, change3.change_id, { confirmed_by: 'owner_a' });
  assert.throws(
    () => closeTrunkChange(db, change3.change_id),
    /INVALID_TRANSITION|不可关闭/,
  );
});

test('HTTP：变更与影响项路由、状态码与错误 code', async () => {
  const project = seed();
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const badCreate = await fetch(`${base}/trunk-changes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: project.project_id }),
    });
    assert.equal(badCreate.status, 400);

    const created = await fetch(`${base}/trunk-changes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: project.project_id,
        reason: 'HTTP 变更',
        old_item_ids: [],
        proposed_items: [{ kind: 'goal', statement: '新目标' }],
      }),
    }).then((res) => res.json());
    assert.equal(created.status, 'proposed');

    const list = await fetch(
      `${base}/trunk-changes?project_id=${project.project_id}&status=proposed`,
    ).then((res) => res.json());
    assert.equal(list.length, 1);

    const fetched = await fetch(`${base}/trunk-changes/${created.change_id}`)
      .then((res) => res.json());
    assert.equal(fetched.change_id, created.change_id);

    const missing = await fetch(`${base}/trunk-changes/chg_missing`);
    assert.equal(missing.status, 404);

    const confirmed = await fetch(`${base}/trunk-changes/${created.change_id}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmed_by: 'owner_http' }),
    });
    assert.equal(confirmed.status, 200);

    const activated = await fetch(`${base}/trunk-changes/${created.change_id}/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmed_by: 'owner_http' }),
    }).then((res) => res.json());
    assert.equal(activated.status, 'in_effect');
    assert.equal(activated.proposed_item_ids.length, 1);
    assert.equal(getTrunkItem(db, activated.proposed_item_ids[0]).status, 'active');

    const impact = await fetch(`${base}/trunk-changes/${created.change_id}/impacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target_type: 'other', target_id: 'doc_x' }),
    }).then((res) => res.json());
    assert.equal(impact.assessment_status, 'to_check');

    const impacts = await fetch(`${base}/trunk-changes/${created.change_id}/impacts`)
      .then((res) => res.json());
    assert.equal(impacts.length, 1);

    const conflict = await fetch(`${base}/trunk-changes/${created.change_id}/close`, {
      method: 'POST',
    });
    assert.equal(conflict.status, 409);
    const conflictBody = await conflict.json();
    assert.equal(conflictBody.code, 'CHANGE_IMPACT_UNRESOLVED');

    const badPatch = await fetch(`${base}/impact-items/${impact.impact_item_id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assessment_status: 'not_affected' }),
    });
    assert.equal(badPatch.status, 400);

    const patched = await fetch(`${base}/impact-items/${impact.impact_item_id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assessment_status: 'not_affected',
        resolution: 'obsolete',
        reason: '该文档不引用旧目标',
      }),
    }).then((res) => res.json());
    assert.equal(patched.assessment_status, 'not_affected');
    assert.equal(patched.resolution, 'obsolete');

    const closed = await fetch(`${base}/trunk-changes/${created.change_id}/close`, {
      method: 'POST',
    }).then((res) => res.json());
    assert.equal(closed.status, 'closed');

    const patchMissing = await fetch(`${base}/impact-items/imp_missing`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assessment_status: 'affected' }),
    });
    assert.equal(patchMissing.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
