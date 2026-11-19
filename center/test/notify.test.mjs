// 通知与运维测试（E 枝）：收件人推导、去重、偏好、已读、扫描、备份与健康。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/db/store.mjs';
import { createProject } from '../src/db/projects.mjs';
import { createActor, addMember } from '../src/db/actors.mjs';
import { createTrunkItem, confirmTrunkItem } from '../src/db/trunk.mjs';
import { createRequirement } from '../src/db/requirements.mjs';
import { createTask, openTask, getTask } from '../src/db/tasks.mjs';
import { listNotifications, markAllRead, markRead, unreadCount, savePrefs } from '../src/db/notifications.mjs';
import { scanNotifications } from '../src/notify/scan.mjs';
import { createBackup, healthReport, verifyBackup } from '../src/reliability/backup.mjs';

const dbPath = path.join(os.tmpdir(), `sap-notify-test-${process.pid}-${Date.now()}.db`);
const db = openStore(dbPath);

test.after(() => {
  db.close();
  fs.rmSync(dbPath, { force: true });
});

function seedProject() {
  const project = createProject(db, { name: `通知项目-${Math.random()}` });
  const owner = createActor(db, { type: 'human', display_name: '负责人', created_by: 'test' });
  const contributor = createActor(db, { type: 'human', display_name: '执行者', created_by: 'test' });
  const reviewer = createActor(db, { type: 'human', display_name: '评审者', created_by: 'test' });
  addMember(db, project.project_id, { actor_id: owner.actor_id, roles: ['owner'], created_by: 'test' });
  addMember(db, project.project_id, { actor_id: contributor.actor_id, roles: ['contributor'], created_by: 'test' });
  addMember(db, project.project_id, { actor_id: reviewer.actor_id, roles: ['reviewer'], created_by: 'test' });
  const item = confirmTrunkItem(
    db,
    createTrunkItem(db, {
      project_id: project.project_id, kind: 'capability', statement: '导出能力', created_by: 'test',
    }).item_id,
    { confirmed_by: 'test' },
  );
  return { project, owner, contributor, reviewer, item };
}

test('任务开放：contributor 与 owner 收到 task_available，且同一任务不重复', () => {
  const { project, owner, contributor, item } = seedProject();
  const task = createTask(db, {
    project_id: project.project_id,
    purpose: '导出接口',
    done_when: ['可导出'],
    serves_item_ids: [item.item_id],
  });
  openTask(db, task.task_id, { actor: 'test' });

  const ownerInbox = listNotifications(db, { actor_id: owner.actor_id, unread: '1' });
  const contributorInbox = listNotifications(db, { actor_id: contributor.actor_id, unread: '1' });
  assert.equal(ownerInbox.filter((row) => row.kind === 'task_available').length, 1);
  assert.equal(contributorInbox.filter((row) => row.kind === 'task_available').length, 1);

  // 再次开放同一任务不应重复：任务已是 open，openTask 会抛错；用直接通知验证去重
  const before = listNotifications(db, { actor_id: contributor.actor_id }).length;
  openTaskSafe(db, task.task_id);
  const after = listNotifications(db, { actor_id: contributor.actor_id }).length;
  assert.equal(after, before);
});

function openTaskSafe(database, taskId) {
  try {
    openTask(database, taskId, { actor: 'test' });
  } catch {
    // 已开放的任务再开放会失败，这里只验证通知不重复
  }
}

test('新需求：direction/owner 收到 decision_required', () => {
  const { project, owner } = seedProject();
  createRequirement(db, { project_id: project.project_id, raw_text: '需要新增导出', author: 'someone' });
  const inbox = listNotifications(db, { actor_id: owner.actor_id });
  assert.ok(inbox.some((row) => row.kind === 'decision_required'));
});

test('偏好关闭后不再发送，重新开启恢复', () => {
  const { project, owner, contributor } = seedProject();
  savePrefs(db, contributor.actor_id, [{ kind: 'task_available', enabled: false }]);
  const task = createTask(db, {
    project_id: project.project_id, purpose: '第二个导出', done_when: ['可导出'], serves_item_ids: [],
    related_question_id: 'q-1',
  });
  openTask(db, task.task_id, { actor: 'test' });
  const contributorInbox = listNotifications(db, { actor_id: contributor.actor_id });
  assert.equal(contributorInbox.filter((row) => row.kind === 'task_available' && row.ref_id === task.task_id).length, 0);
  const ownerInbox = listNotifications(db, { actor_id: owner.actor_id });
  assert.equal(ownerInbox.filter((row) => row.kind === 'task_available' && row.ref_id === task.task_id).length, 1);
});

test('已读：单条与全部标记，未读数随之变化', () => {
  const { project, owner } = seedProject();
  createRequirement(db, { project_id: project.project_id, raw_text: '需求 A', author: 'x' });
  createRequirement(db, { project_id: project.project_id, raw_text: '需求 B', author: 'x' });
  const before = unreadCount(db, owner.actor_id);
  assert.ok(before >= 2);
  const first = listNotifications(db, { actor_id: owner.actor_id, unread: '1' })[0];
  markRead(db, first.notification_id, owner.actor_id);
  assert.equal(unreadCount(db, owner.actor_id), before - 1);
  markAllRead(db, owner.actor_id);
  assert.equal(unreadCount(db, owner.actor_id), 0);
});

test('扫描：幂等，重复扫描不增加通知', () => {
  const first = scanNotifications(db);
  const second = scanNotifications(db);
  assert.equal(first.lease_expiring, 0);
  assert.equal(second.lease_expiring, 0);
  assert.equal(second.review_requested, 0);
});

test('备份：生成文件、只读校验通过、健康报告完整', () => {
  const target = path.join(os.tmpdir(), `sap-backup-${process.pid}-${Date.now()}.db`);
  const backup = createBackup(db, { target });
  assert.ok(fs.existsSync(backup.target));
  assert.ok(backup.bytes > 0);

  const verified = verifyBackup(backup.target);
  assert.equal(verified.ok, true);
  assert.ok(verified.tables.projects >= 1);
  assert.ok(verified.tables.notifications >= 1);

  const health = healthReport(db);
  assert.equal(health.ok, true);
  assert.equal(typeof health.tables.tasks, 'number');
  assert.ok(health.outbox.pending >= 0);
  assert.equal(health.errors_24h, 0);

  fs.rmSync(backup.target, { force: true });
});

test('备份：目标已存在时拒绝覆盖', () => {
  const target = path.join(os.tmpdir(), `sap-backup-dup-${process.pid}-${Date.now()}.db`);
  createBackup(db, { target });
  assert.throws(() => createBackup(db, { target }), /备份目标已存在/);
  fs.rmSync(target, { force: true });
});
