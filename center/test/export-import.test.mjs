// 导出/导入测试（F 枝）：行数与内容一致、dry-run 不写库、外键顺序正确。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..');
const EXPORT_BIN = path.join(CENTER_ROOT, 'bin', 'export-data.mjs');
const IMPORT_BIN = path.join(CENTER_ROOT, 'bin', 'import-data.mjs');

const { openStore } = await import('../src/db/store.mjs');
const { createProject } = await import('../src/db/projects.mjs');
const { createRequirement } = await import('../src/db/requirements.mjs');
const { createTask, openTask } = await import('../src/db/tasks.mjs');
const { createTrunkItem } = await import('../src/db/trunk.mjs');

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-export-'));
  return {
    dir,
    db: path.join(dir, 'source.db'),
    dump: path.join(dir, 'dump.json'),
    target: path.join(dir, 'target.db'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function seed(dbPath) {
  const db = openStore(dbPath);
  try {
    const project = createProject(db, { name: '导出测试项目' });
    const item = createTrunkItem(db, {
      project_id: project.project_id,
      kind: 'goal',
      statement: '验证导出导入',
      rationale: '测试',
      created_by: 'tester',
    });
    const requirement = createRequirement(db, {
      project_id: project.project_id,
      author: 'tester',
      raw_text: '一条需求',
      related_item_ids: [item.item_id],
    });
    const task = createTask(db, {
      project_id: project.project_id,
      requirement_id: requirement.requirement_id,
      purpose: '做一件事',
      done_when: ['可验证'],
      serves_item_ids: [item.item_id],
      created_by: 'tester',
    });
    openTask(db, task.task_id, { actor: 'tester' });
    return { project, item, requirement, task };
  } finally {
    db.close();
  }
}

test('导出 → 导入：行数与 JSON 字段一致', () => {
  const ws = workspace();
  try {
    const seeded = seed(ws.db);
    execFileSync(process.execPath, [EXPORT_BIN, '--out', ws.dump, '--db', ws.db], { stdio: 'pipe' });
    const dump = JSON.parse(fs.readFileSync(ws.dump, 'utf8'));
    assert.equal(dump.dialect, 'sqlite');
    assert.equal(dump.tables.projects.length, 1);
    assert.equal(dump.tables.tasks[0].task_id, seeded.task.task_id);

    execFileSync(process.execPath, [IMPORT_BIN, '--in', ws.dump, '--target', ws.target], { stdio: 'pipe' });

    const db = openStore(ws.target, { migrate: false });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
      const row = db.prepare('SELECT * FROM requirements').get();
      assert.equal(row.requirement_id, seeded.requirement.requirement_id);
      assert.deepEqual(JSON.parse(row.related_item_ids), [seeded.item.item_id]);
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally {
      db.close();
    }
  } finally {
    ws.cleanup();
  }
});

test('导入 --dry-run 不写目标库', () => {
  const ws = workspace();
  try {
    seed(ws.db);
    execFileSync(process.execPath, [EXPORT_BIN, '--out', ws.dump, '--db', ws.db], { stdio: 'pipe' });
    const out = execFileSync(process.execPath, [IMPORT_BIN, '--in', ws.dump, '--target', ws.target, '--dry-run'], {
      encoding: 'utf8',
    });
    assert.match(out, /dry-run/);
    assert.equal(fs.existsSync(ws.target), false);
  } finally {
    ws.cleanup();
  }
});

test('导入失败回滚：载荷缺主键时不留下半成品', () => {
  const ws = workspace();
  try {
    seed(ws.db);
    execFileSync(process.execPath, [EXPORT_BIN, '--out', ws.dump, '--db', ws.db], { stdio: 'pipe' });
    const dump = JSON.parse(fs.readFileSync(ws.dump, 'utf8'));
    // 让第二张需要写入的表出现非法行，触发事务回滚。
    dump.tables.tasks.push({ ...dump.tables.tasks[0], task_id: dump.tables.tasks[0].task_id });
    fs.writeFileSync(ws.dump, JSON.stringify(dump), 'utf8');

    assert.throws(() => execFileSync(
      process.execPath,
      [IMPORT_BIN, '--in', ws.dump, '--target', path.join(ws.dir, 'rollback.db')],
      { stdio: 'pipe' },
    ));

    const target = path.join(ws.dir, 'rollback.db');
    assert.equal(fs.existsSync(target), true);
    const db = openStore(target, { migrate: false });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 0);
    } finally {
      db.close();
    }
  } finally {
    ws.cleanup();
  }
});
