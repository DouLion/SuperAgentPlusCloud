// 旧库升级测试：验证 impact_items 重建迁移不会丢列、不会让登记影响项失败。
// 背景：B 枝首次重建漏了 target_id，导致旧库创建演示项目时「登记影响」500。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../src/store.mjs';

function tmpDb(name) {
  return path.join(os.tmpdir(), `sap-migration-${name}-${process.pid}-${Date.now()}.db`);
}

/** 清理临时库；文件被占用时不掩盖原错误。 */
function cleanup(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // 忽略清理失败：断言结果比临时文件更重要。
  }
}

/** 只造一张老版 impact_items，其余表交给 schema 迁移创建。 */
function seedLegacyImpactTable(file, sql) {
  const db = new DatabaseSync(file);
  db.exec(sql);
  db.close();
}

const LEGACY_WITH_TARGET = `
  CREATE TABLE impact_items (
    impact_item_id    TEXT PRIMARY KEY,
    change_id         TEXT NOT NULL,
    target_type       TEXT NOT NULL,
    target_id         TEXT NOT NULL,
    assessment_status TEXT NOT NULL DEFAULT 'to_check',
    resolution        TEXT NOT NULL DEFAULT 'pending',
    reason            TEXT,
    owner_id          TEXT,
    updated_at        TEXT NOT NULL,
    created_at        TEXT NOT NULL
  );
  INSERT INTO impact_items (
    impact_item_id, change_id, target_type, target_id, assessment_status,
    resolution, reason, owner_id, updated_at, created_at
  ) VALUES ('imp_old', 'chg_old', 'task', 'task_old', 'to_check', 'pending', '旧影响', '老张',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
`;

const LEGACY_WITHOUT_TARGET = `
  CREATE TABLE impact_items (
    impact_item_id    TEXT PRIMARY KEY,
    change_id         TEXT,
    source_type       TEXT NOT NULL DEFAULT 'trunk_change',
    source_id         TEXT,
    target_type       TEXT NOT NULL,
    assessment_status TEXT NOT NULL DEFAULT 'to_check',
    resolution        TEXT NOT NULL DEFAULT 'pending',
    reason            TEXT,
    owner_id          TEXT,
    updated_at        TEXT NOT NULL,
    created_at        TEXT NOT NULL
  );
`;

test('旧库升级：重建 impact_items 时保留 target_id 与历史数据', () => {
  const file = tmpDb('rebuild');
  seedLegacyImpactTable(file, LEGACY_WITH_TARGET);
  const db = openStore(file);
  try {
    const columns = db.prepare('PRAGMA table_info(impact_items)').all().map((c) => c.name);
    assert.ok(columns.includes('source_type'));
    assert.ok(columns.includes('source_id'));
    assert.ok(columns.includes('target_id'), 'target_id 不能在迁移中丢失');

    const row = db.prepare('SELECT * FROM impact_items WHERE impact_item_id = ?').get('imp_old');
    assert.equal(row.target_id, 'task_old', '历史 target_id 必须保留');
    assert.equal(row.source_type, 'trunk_change');
    assert.equal(row.source_id, 'chg_old');
    assert.equal(row.reason, '旧影响');

    const now = new Date().toISOString();
    db.prepare(`INSERT INTO impact_items (
      impact_item_id, change_id, source_type, source_id, target_type, target_id,
      assessment_status, resolution, reason, owner_id, updated_at, created_at
    ) VALUES ('imp_new', NULL, 'artifact', 'art_1', 'task', 'task_new',
              'to_check', 'pending', '新影响', '老张', ?, ?)`).run(now, now);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM impact_items').get().n, 2);

    const index = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_impact_items_source'",
    ).get();
    assert.ok(index, '依赖新列的索引应在补列之后创建');
  } finally {
    db.close();
    cleanup(file);
  }
});

test('已迁移但缺 target_id 的库：自动补列并可写入', () => {
  const file = tmpDb('addcol');
  seedLegacyImpactTable(file, LEGACY_WITHOUT_TARGET);
  const db = openStore(file);
  try {
    const columns = db.prepare('PRAGMA table_info(impact_items)').all().map((c) => c.name);
    assert.ok(columns.includes('target_id'), '缺列的旧库应被补上 target_id');

    const now = new Date().toISOString();
    db.prepare(`INSERT INTO impact_items (
      impact_item_id, change_id, source_type, source_id, target_type, target_id,
      assessment_status, resolution, updated_at, created_at
    ) VALUES ('imp_fix', NULL, 'artifact', 'art_1', 'submission', 'sub_1', 'to_check', 'pending', ?, ?)`)
      .run(now, now);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM impact_items').get().n, 1);
  } finally {
    db.close();
    cleanup(file);
  }
});
