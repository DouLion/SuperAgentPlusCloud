// Center 需求与定级测试（T2）。
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
  getProject,
  listProjects,
  createRequirement,
  getRequirement,
  listRequirements,
  updateRequirementStatus,
  createAssessment,
  listAssessments,
  createDecision,
  listDecisions,
  listRequirementTimeline,
  listEvents,
} from '../src/store.mjs';

const dbPath = path.join(
  os.tmpdir(),
  `sap-center-req-test-${process.pid}-${Date.now()}.db`,
);

let db;

test.before(() => {
  db = openStore(dbPath);
});

test.after(() => {
  db.close();
  fs.rmSync(dbPath, { force: true });
});

test('项目：创建、查询、列表与状态校验', () => {
  const project = createProject(db, {
    name: 'T2 演示项目',
    purpose: '跑通需求到决定链路',
    created_by: 'tester',
  });
  assert.match(project.project_id, /^prj_/);
  assert.equal(project.status, 'active');
  assert.equal(getProject(db, project.project_id).name, 'T2 演示项目');
  assert.equal(getProject(db, 'prj_missing'), null);
  assert.equal(listProjects(db).length, 1);
  assert.throws(() => createProject(db, { name: 'x', status: 'bogus' }), /非法的项目状态/);
});

test('需求：建项目 → 建需求，原文与 JSON 字段往返一致', () => {
  const project = createProject(db, { name: '需求项目' });
  const attachments = ['docs/材料A.md', 'meeting/2026-11-18'];
  const relatedItemIds = ['item_a', 'item_b'];

  const requirement = createRequirement(db, {
    project_id: project.project_id,
    raw_text: '希望支持按项目导出需求清单',
    author: 'bob',
    source_ref: 'sap submit',
    claimed_level: 'L2',
    claimed_reason: '影响导出模块',
    attachments,
    related_item_ids: relatedItemIds,
  });

  assert.match(requirement.requirement_id, /^req_/);
  assert.equal(requirement.project_id, project.project_id);
  assert.equal(requirement.raw_text, '希望支持按项目导出需求清单');
  assert.equal(requirement.author, 'bob');
  assert.equal(requirement.claimed_level, 'L2');
  assert.equal(requirement.status, 'submitted');
  assert.deepEqual(requirement.attachments, attachments);
  assert.deepEqual(requirement.related_item_ids, relatedItemIds);

  const fetched = getRequirement(db, requirement.requirement_id);
  assert.equal(fetched.raw_text, requirement.raw_text);
  assert.deepEqual(fetched.attachments, attachments);
  assert.deepEqual(fetched.related_item_ids, relatedItemIds);

  assert.equal(listRequirements(db, { projectId: project.project_id }).length, 1);
  assert.equal(listRequirements(db, { status: 'submitted' }).length, 1);
  assert.equal(listRequirements(db, { status: 'accepted' }).length, 0);
  assert.equal(getRequirement(db, 'req_missing'), null);
});

test('需求：未填等级不报错，默认状态 submitted；缺必填字段与不存在项目抛错', () => {
  const project = createProject(db, { name: '无等级项目' });
  const requirement = createRequirement(db, {
    project_id: project.project_id,
    raw_text: '只写了一句问题描述',
  });
  assert.equal(requirement.claimed_level, null);
  assert.equal(requirement.status, 'submitted');

  assert.throws(
    () => createRequirement(db, { raw_text: '缺少项目' }),
    /缺少必填字段：project_id/,
  );
  assert.throws(
    () => createRequirement(db, { project_id: 'prj_missing', raw_text: 'x' }),
    /项目不存在/,
  );
});

test('需求状态更新：合法枚举、非法值与不存在 ID 抛错', () => {
  const project = createProject(db, { name: '状态项目' });
  const requirement = createRequirement(db, {
    project_id: project.project_id,
    raw_text: '状态流转',
  });

  const updated = updateRequirementStatus(db, requirement.requirement_id, 'needs_info', {
    claimed_reason: '补充材料',
    actor: 'alice',
    reason: '信息不足',
  });
  assert.equal(updated.status, 'needs_info');
  assert.equal(updated.claimed_reason, '补充材料');

  assert.throws(
    () => updateRequirementStatus(db, requirement.requirement_id, 'bogus'),
    /非法的需求状态/,
  );
  assert.throws(
    () => updateRequirementStatus(db, 'req_missing', 'accepted'),
    /需求不存在/,
  );
});

test('评估：创建后需求状态自动变为 assessed，字段往返一致', () => {
  const project = createProject(db, { name: '评估项目' });
  const requirement = createRequirement(db, {
    project_id: project.project_id,
    raw_text: '评估演示',
  });

  const assessment = createAssessment(db, {
    requirement_id: requirement.requirement_id,
    assessed_level: 'L2',
    proposed_action: 'relevel',
    impact_summary: '影响导出与权限',
    uncertainties: ['未确认数据量'],
    assessor_id: 'ai-session-1',
  });

  assert.match(assessment.assessment_id, /^asm_/);
  assert.equal(assessment.assessed_level, 'L2');
  assert.equal(assessment.proposed_action, 'relevel');
  assert.equal(assessment.assessor_type, 'AI');
  assert.deepEqual(assessment.uncertainties, ['未确认数据量']);

  assert.equal(getRequirement(db, requirement.requirement_id).status, 'assessed');
  assert.equal(listAssessments(db, requirement.requirement_id).length, 1);

  // 缺省等级为 undecided；旧评估保留，可再次评估。
  const second = createAssessment(db, { requirement_id: requirement.requirement_id });
  assert.equal(second.assessed_level, 'undecided');
  assert.equal(listAssessments(db, requirement.requirement_id).length, 2);
  assert.equal(getRequirement(db, requirement.requirement_id).status, 'assessed');

  assert.throws(
    () => createAssessment(db, { requirement_id: requirement.requirement_id, assessed_level: 'L9' }),
    /非法的评估等级/,
  );
  assert.throws(
    () => createAssessment(db, { requirement_id: requirement.requirement_id, proposed_action: 'bogus' }),
    /非法的建议动作/,
  );
  assert.throws(
    () => createAssessment(db, { requirement_id: 'req_missing' }),
    /需求不存在/,
  );
});

test('决定：accepted 缺 confirmed_by 抛错；缺 final_level 抛错', () => {
  const project = createProject(db, { name: '决定校验项目' });
  const requirement = createRequirement(db, {
    project_id: project.project_id,
    raw_text: '决定校验',
  });

  assert.throws(
    () => createDecision(db, {
      requirement_id: requirement.requirement_id,
      conclusion: 'accepted',
      final_level: 'L1',
    }),
    /缺少必填字段：confirmed_by/,
  );
  assert.throws(
    () => createDecision(db, {
      requirement_id: requirement.requirement_id,
      conclusion: 'accepted',
      confirmed_by: 'alice',
    }),
    /必须提供 final_level/,
  );
  assert.throws(
    () => createDecision(db, {
      requirement_id: requirement.requirement_id,
      conclusion: 'relevelled',
      final_level: 'L1',
      confirmed_by: 'alice',
    }),
    /必须提供 reason/,
  );
  assert.throws(
    () => createDecision(db, {
      requirement_id: 'req_missing',
      conclusion: 'accepted',
      final_level: 'L1',
      confirmed_by: 'alice',
    }),
    /需求不存在/,
  );
  assert.throws(
    () => createDecision(db, {
      requirement_id: requirement.requirement_id,
      conclusion: 'bogus',
      confirmed_by: 'alice',
    }),
    /非法的决定结论/,
  );
});

test('决定：relevelled 写入后需求为 accepted 且等级按 final_level 记录', () => {
  const project = createProject(db, { name: '改级项目' });
  const requirement = createRequirement(db, {
    project_id: project.project_id,
    raw_text: '改级演示',
    claimed_level: 'L3',
  });

  const decision = createDecision(db, {
    requirement_id: requirement.requirement_id,
    conclusion: 'relevelled',
    final_level: 'L1',
    reason: '实际只影响单一模块',
    confirmed_by: 'alice',
  });

  assert.match(decision.decision_id, /^dec_/);
  assert.equal(decision.final_level, 'L1');
  assert.equal(decision.confirmed_by, 'alice');

  const updated = getRequirement(db, requirement.requirement_id);
  assert.equal(updated.status, 'accepted');
  assert.equal(updated.final_level, 'L1');
  // 提交者自报等级不被覆盖。
  assert.equal(updated.claimed_level, 'L3');

  assert.equal(listDecisions(db, requirement.requirement_id).length, 1);
});

test('决定：rejected 写入后需求为 rejected；needs_info/deferred 落到 needs_info', () => {
  const project = createProject(db, { name: '拒绝项目' });

  const rejectedReq = createRequirement(db, {
    project_id: project.project_id,
    raw_text: '拒绝演示',
  });
  createDecision(db, {
    requirement_id: rejectedReq.requirement_id,
    conclusion: 'rejected',
    reason: '超出本期范围',
    confirmed_by: 'alice',
  });
  assert.equal(getRequirement(db, rejectedReq.requirement_id).status, 'rejected');

  const deferredReq = createRequirement(db, {
    project_id: project.project_id,
    raw_text: '暂缓演示',
  });
  createDecision(db, {
    requirement_id: deferredReq.requirement_id,
    conclusion: 'deferred',
    reason: '等待上游决定',
    confirmed_by: 'bob',
  });
  assert.equal(getRequirement(db, deferredReq.requirement_id).status, 'needs_info');

  const infoReq = createRequirement(db, {
    project_id: project.project_id,
    raw_text: '追问演示',
  });
  createDecision(db, {
    requirement_id: infoReq.requirement_id,
    conclusion: 'needs_info',
    reason: '需要补充材料',
    confirmed_by: 'bob',
  });
  assert.equal(getRequirement(db, infoReq.requirement_id).status, 'needs_info');
});

test('事件：每次变更都产生事件，时间线按发生时间升序且可过滤', () => {
  const project = createProject(db, { name: '事件项目' });
  const requirement = createRequirement(db, {
    project_id: project.project_id,
    raw_text: '事件演示',
    author: 'bob',
  });
  createAssessment(db, {
    requirement_id: requirement.requirement_id,
    assessed_level: 'L2',
    proposed_action: 'accept',
  });
  createDecision(db, {
    requirement_id: requirement.requirement_id,
    conclusion: 'accepted',
    final_level: 'L2',
    confirmed_by: 'alice',
  });

  const types = listEvents(db, { projectId: project.project_id }).map((e) => e.event_type);
  for (const expected of [
    'project.created',
    'requirement.submitted',
    'requirement.updated',
    'assessment.created',
    'decision.confirmed',
  ]) {
    assert.ok(types.includes(expected), `缺少事件：${expected}`);
  }

  const timeline = listRequirementTimeline(db, requirement.requirement_id);
  assert.ok(timeline.length >= 4);
  for (let i = 1; i < timeline.length; i += 1) {
    assert.ok(
      timeline[i - 1].occurred_at <= timeline[i].occurred_at,
      '时间线未按发生时间升序',
    );
  }
  assert.ok(
    timeline.some((e) => e.event_type === 'assessment.created'),
    '时间线缺少评估事件',
  );
  assert.ok(
    timeline.some((e) => e.event_type === 'decision.confirmed'),
    '时间线缺少决定事件',
  );

  assert.throws(() => listRequirementTimeline(db, 'req_missing'), /需求不存在/);
});
