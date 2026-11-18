#!/usr/bin/env node
// SuperAgentPlus 端到端脚本（T6）：用临时 SQLite 库在进程内启动 Center，
// 通过真实 HTTP 接口与真实 Client 命令跑通完整链路。
//
// 运行：node client/bin/e2e.mjs（或根目录 npm run e2e）
// 说明：放在 client/bin 而非 center/bin，因为链路的主体动作由 Client 发起；
//       Center 以进程内 createServer + 临时库方式启动，端口用 0（系统分配），
//       避免与本机已有 Center 冲突。结束后关闭服务、删除临时库。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../../center/src/store.mjs';
import { createServer } from '../../center/src/server.mjs';
import { api } from '../src/api.mjs';
import { run as runTrunk } from '../src/commands/trunk.mjs';

/** 启动临时 Center，返回 { server, db, base, cleanup }。 */
async function startCenter() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-e2e-'));
  const dbPath = path.join(dir, 'center.db');
  const db = openStore(dbPath);
  const server = createServer(db);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const cleanup = async () => {
    server.closeIdleConnections?.();
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };

  return { server, db, base, cleanup };
}

/** 捕获 Client 命令输出。 */
function captureIo() {
  const lines = [];
  const errors = [];
  return {
    lines,
    errors,
    io: {
      stdout: (line) => lines.push(line),
      stderr: (line) => errors.push(line),
    },
  };
}

async function main() {
  const center = await startCenter();
  const originalCenterUrl = process.env.CENTER_URL;
  process.env.CENTER_URL = center.base;

  const summary = {};
  let failed = false;

  /** 执行一个步骤；失败时打印步骤名与原因并向上抛出。 */
  async function step(name, fn) {
    try {
      const detail = await fn();
      console.log(`✓ ${name}${detail ? `：${detail}` : ''}`);
      return detail;
    } catch (error) {
      console.error(`✗ 步骤失败：${name}`);
      console.error(`  原因：${error instanceof Error ? error.message : String(error)}`);
      if (error && typeof error === 'object') error.stepFailed = true;
      throw error;
    }
  }

  try {
    // 1. 建项目
    const projectId = await step('建项目', async () => {
      const created = await api.createProject({
        name: 'T6 端到端项目',
        purpose: '验证主干到评审的完整链路',
        created_by: 'owner',
      });
      assert.match(created.project_id, /^prj_/);
      assert.equal(created.status, 'active');
      summary.project = created;
      return created.project_id;
    });

    // 2. 建并确认主干条目（propose 用 Client 命令，confirm 也用 Client 命令）
    const item = await step('建并确认主干条目（proposed → active）', async () => {
      const proposed = captureIo();
      const code = await runTrunk([
        'propose',
        '--project', projectId,
        '--kind', 'goal',
        '--statement', '一期跑通需求到评审链路',
        '--rationale', '验证流程可行性',
        '--source', 'docs/03_总体架构.md',
        '--by', 'owner',
      ], proposed.io);
      assert.equal(code, 0, `trunk propose 退出码 ${code}：${proposed.errors.join('；')}`);
      assert.ok(proposed.lines.some((line) => line.includes('主干条目已提出')));

      const list = await api.listTrunkItems({ project_id: projectId });
      assert.equal(list.length, 1);
      const created = list[0];
      assert.equal(created.status, 'proposed');

      const confirmed = captureIo();
      const confirmCode = await runTrunk([
        'confirm',
        '--item', created.item_id,
        '--by', 'owner',
        '--valid-from', '2026-11-18T00:00:00.000Z',
      ], confirmed.io);
      assert.equal(confirmCode, 0, `trunk confirm 退出码 ${confirmCode}：${confirmed.errors.join('；')}`);

      const active = await api.getTrunkItem(created.item_id);
      assert.equal(active.status, 'active');
      assert.equal(active.confirmed_by, 'owner');
      assert.equal(active.valid_from, '2026-11-18T00:00:00.000Z');
      summary.item = active;
      return `${active.item_id}（${active.status}）`;
    });

    // 3. 提交需求
    await step('提交需求（submitted）', async () => {
      const created = await api.createRequirement({
        project_id: projectId,
        raw_text: '希望主干变更时能列出影响对象并逐项处置',
        claimed_level: 'L2',
        claimed_reason: '涉及范围调整',
        source_ref: 'meeting/2026-11-18',
        author: 'alice',
      });
      assert.equal(created.status, 'submitted');
      summary.requirement = created;
      return created.requirement_id;
    });

    // 4. 评估
    await step('评估（submitted → assessed）', async () => {
      await api.createAssessment(summary.requirement.requirement_id, {
        assessed_level: 'L2',
        proposed_action: 'relevel',
        impact_summary: '影响范围说明，需要改级处理',
        uncertainties: ['影响对象清单需人工确认'],
        assessor_type: 'AI',
        assessor_id: 'ai-1',
        related_item_ids: [summary.item.item_id],
      });
      const after = await api.getRequirement(summary.requirement.requirement_id);
      assert.equal(after.status, 'assessed');
      return summary.requirement.requirement_id;
    });

    // 5. 改级决定
    await step('改级决定（relevelled → accepted，L2 → L1）', async () => {
      await api.createDecision(summary.requirement.requirement_id, {
        conclusion: 'relevelled',
        final_level: 'L1',
        reason: '仅影响范围说明，不改变目标',
        confirmed_by: 'owner',
      });
      const after = await api.getRequirement(summary.requirement.requirement_id);
      assert.equal(after.status, 'accepted');
      assert.equal(after.final_level, 'L1');
      return `最终等级 ${after.final_level}`;
    });

    // 6. 拆任务
    await step('拆任务（open）', async () => {
      const tasks = await api.createRequirementTasks(summary.requirement.requirement_id, {
        tasks: [{
          purpose: '更新范围说明并登记影响对象',
          scope: '仅文档',
          non_scope: '不修改代码',
          done_when: ['文档已更新并提交', '影响对象已逐项处置'],
          serves_item_ids: [summary.item.item_id],
          acceptance_evidence: ['提交引用'],
          created_by: 'owner',
        }],
      });
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].status, 'open');
      summary.task = tasks[0];
      return tasks[0].task_id;
    });

    // 7. 认领
    await step('认领任务（claimed）', async () => {
      const result = await api.claimTask(summary.task.task_id, { worker_id: 'worker_a' });
      assert.equal(result.task.status, 'claimed');
      assert.equal(result.claim.status, 'active');
      return `claim ${result.claim.claim_id}`;
    });

    // 8. 提交成果
    await step('提交成果（submitted）', async () => {
      const submission = await api.createSubmission(summary.task.task_id, {
        commit_refs: [{ repo: 'git@example.com:repo.git', hash: 'abc123' }],
        summary: '更新范围说明初稿',
        self_test: 'npm test 通过',
        submitted_by: 'worker_a',
      });
      const after = await api.getTask(summary.task.task_id);
      assert.equal(after.status, 'submitted');
      summary.firstSubmission = submission;
      return submission.submission_id;
    });

    // 9. 评审打回
    await step('评审打回（submitted → rework）', async () => {
      await api.createReview(summary.firstSubmission.submission_id, {
        reviewer_id: 'reviewer_b',
        conclusion: 'reject',
        reason: '缺少影响对象清单',
        criterion_results: [{ criterion: '文档已更新并提交', result: 'fail', evidence: '未见清单' }],
      });
      const after = await api.getTask(summary.task.task_id);
      assert.equal(after.status, 'rework');
      return summary.firstSubmission.submission_id;
    });

    // 10. 重新认领
    await step('重新认领（rework → claimed）', async () => {
      const result = await api.claimTask(summary.task.task_id, { worker_id: 'worker_a' });
      assert.equal(result.task.status, 'claimed');
      return `claim ${result.claim.claim_id}`;
    });

    // 11. 再提交
    await step('再次提交成果（submitted）', async () => {
      const submission = await api.createSubmission(summary.task.task_id, {
        commit_refs: [{ repo: 'git@example.com:repo.git', hash: 'def456' }],
        summary: '补充影响对象清单',
        self_test: 'npm test 通过',
        submitted_by: 'worker_a',
      });
      assert.equal((await api.getTask(summary.task.task_id)).status, 'submitted');
      summary.secondSubmission = submission;
      return submission.submission_id;
    });

    // 12. 评审确认
    await step('评审确认（submitted → accepted）', async () => {
      await api.createReview(summary.secondSubmission.submission_id, {
        reviewer_id: 'reviewer_b',
        conclusion: 'confirm',
        criterion_results: [
          { criterion: '文档已更新并提交', result: 'pass', evidence: '提交 def456' },
          { criterion: '影响对象已逐项处置', result: 'pass', evidence: '清单已登记' },
        ],
      });
      assert.equal((await api.getTask(summary.task.task_id)).status, 'accepted');
      return summary.secondSubmission.submission_id;
    });

    // 13. 主干变更（旧条目被替代）
    await step('主干变更（旧条目 superseded，新条目 active）', async () => {
      const proposed = await api.createTrunkChange({
        project_id: projectId,
        reason: '范围说明需要对外公开',
        trigger_requirement_id: summary.requirement.requirement_id,
        old_item_ids: [summary.item.item_id],
        proposed_items: [{
          kind: 'goal',
          statement: '一期跑通需求到评审链路，并对外开放范围说明',
          rationale: '业务已对外提供服务',
        }],
        impact_assessment: '已检查在途任务与文档',
      });
      assert.equal(proposed.status, 'proposed');
      const newItemId = proposed.proposed_item_ids[0];

      const confirmed = await api.confirmTrunkChange(proposed.change_id, {
        confirmed_by: 'owner',
        effective_at: '2026-11-19T00:00:00.000Z',
      });
      assert.equal(confirmed.status, 'confirmed');

      const effective = await api.activateTrunkChange(proposed.change_id, { confirmed_by: 'owner' });
      assert.equal(effective.status, 'in_effect');

      const oldAfter = await api.getTrunkItem(summary.item.item_id);
      assert.equal(oldAfter.status, 'superseded');
      assert.equal(oldAfter.superseded_by, newItemId);
      const newAfter = await api.getTrunkItem(newItemId);
      assert.equal(newAfter.status, 'active');

      summary.change = effective;
      summary.newItem = newAfter;
      return `${effective.change_id}（${oldAfter.item_id} → ${newItemId}）`;
    });

    // 14. 影响项登记与处置
    await step('影响项登记与处置（to_check → not_affected）', async () => {
      const added = await api.addImpactItem(summary.change.change_id, {
        target_type: 'task',
        target_id: summary.task.task_id,
        owner_id: 'owner',
      });
      assert.equal(added.assessment_status, 'to_check');

      const handled = await api.updateImpactItem(added.impact_item_id, {
        assessment_status: 'not_affected',
        resolution: 'obsolete',
        reason: '任务已完成，不依赖旧范围表述',
      });
      assert.equal(handled.assessment_status, 'not_affected');
      summary.impact = handled;
      return handled.impact_item_id;
    });

    // 15. 变更关闭
    await step('变更关闭（in_effect → closed）', async () => {
      const closed = await api.closeTrunkChange(summary.change.change_id);
      assert.equal(closed.status, 'closed');
      return summary.change.change_id;
    });

    // 16. Client trunk 命令补充验证：list / show / retire / 非法流转
    await step('Client trunk 命令：list / show / retire / 非法流转', async () => {
      const list = captureIo();
      assert.equal(await runTrunk([
        'list', '--project', projectId, '--status', 'active',
      ], list.io), 0);
      assert.ok(list.lines.some((line) => line.includes(summary.newItem.item_id)));
      assert.ok(!list.lines.some((line) => line.includes(summary.item.item_id)));

      const show = captureIo();
      assert.equal(await runTrunk(['show', '--item', summary.item.item_id], show.io), 0);
      assert.ok(show.lines.some((line) => line.includes('被替代为')));
      assert.ok(show.lines.some((line) => line.includes(summary.newItem.item_id)));

      const extra = await api.createTrunkItem({
        project_id: projectId,
        kind: 'other',
        statement: '临时约定：仅演示退役',
      });
      await api.confirmTrunkItem(extra.item_id, { confirmed_by: 'owner' });

      const retire = captureIo();
      assert.equal(await runTrunk([
        'retire', '--item', extra.item_id, '--by', 'owner',
      ], retire.io), 0);
      assert.equal((await api.getTrunkItem(extra.item_id)).status, 'retired');

      const invalid = captureIo();
      assert.equal(await runTrunk([
        'confirm', '--item', extra.item_id, '--by', 'owner',
      ], invalid.io), 1);
      assert.ok(invalid.errors.some((line) => line.includes('INVALID_TRANSITION')
        || line.includes('不可确认')));

      summary.retiredItem = extra;
      return `已退役 ${extra.item_id}`;
    });

    // 链路摘要
    console.log('');
    console.log('端到端链路摘要：');
    console.log(`  项目：${summary.project.project_id}`);
    console.log(`  主干条目：${item} → superseded（被 ${summary.newItem.item_id} 替代）`);
    console.log(`  需求：${summary.requirement.requirement_id} submitted → assessed → accepted（L2 → L1）`);
    console.log(`  任务：${summary.task.task_id} open → claimed → submitted → rework → claimed → submitted → accepted`);
    console.log(`  提交：${summary.firstSubmission.submission_id} 打回，${summary.secondSubmission.submission_id} 确认`);
    console.log(`  主干变更：${summary.change.change_id} proposed → confirmed → in_effect → closed`);
    console.log(`  影响项：${summary.impact.impact_item_id} to_check → not_affected（obsolete）`);
    console.log('全部断言通过。');
  } catch (error) {
    failed = true;
    // step() 已打印步骤名与原因；这里兜底打印其它异常。
    if (!(error instanceof Error && error.stepFailed)) {
      console.error(`端到端执行失败：${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    if (originalCenterUrl === undefined) delete process.env.CENTER_URL;
    else process.env.CENTER_URL = originalCenterUrl;
    await center.cleanup();
  }

  process.exitCode = failed ? 1 : 0;
}

main();
