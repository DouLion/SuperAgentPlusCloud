#!/usr/bin/env node
// 数据导入（F 枝）：把 export-data.mjs 导出的 JSON 写入一个空库。
// 用法：
//   node center/bin/import-data.mjs --in dump.json --target new.db [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import { openStore } from '../src/db/store.mjs';

/** 父表在前，保证外键可满足；未列出的表放最后。 */
const TABLE_ORDER = [
  'projects',
  'actors',
  'actor_credentials',
  'delegations',
  'project_members',
  'actor_capabilities',
  'trunk_items',
  'events',
  'requirements',
  'assessments',
  'decisions',
  'tasks',
  'claims',
  'submissions',
  'reviews',
  'trunk_changes',
  'impact_items',
  'ai_suggestions',
  'convention_packs',
  'workflow_templates',
  'definition_events',
  'artifacts',
  'materials',
  'material_extractions',
  'command_ledger',
  'outbox',
  'notifications',
  'notification_prefs',
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--in') { args.input = argv[i + 1]; i += 1; }
    else if (token === '--target') { args.target = argv[i + 1]; i += 1; }
    else if (token === '--dry-run') { args.dryRun = true; }
    else if (token === '--help' || token === '-h') { args.help = true; }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.input || !args.target) {
  console.log('用法：node center/bin/import-data.mjs --in <file.json> --target <db path> [--dry-run]');
  process.exit(args.help ? 0 : 1);
}

const inputPath = path.resolve(args.input);
if (!fs.existsSync(inputPath)) {
  console.error(`导入文件不存在：${inputPath}`);
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
} catch (error) {
  console.error(`导入文件不是合法 JSON：${error.message}`);
  process.exit(1);
}

if (!payload || typeof payload !== 'object' || !payload.tables || typeof payload.tables !== 'object') {
  console.error('导入文件缺少 tables 字段，或结构不正确');
  process.exit(1);
}
if (payload.dialect && payload.dialect !== 'sqlite') {
  console.error(`暂不支持从 ${payload.dialect} 导入；本脚本面向 SQLite 导出文件`);
  process.exit(1);
}

const targetPath = path.resolve(args.target);
if (!args.dryRun && fs.existsSync(targetPath)) {
  console.error(`目标库已存在：${targetPath}。为保证安全，请先删除或换一个路径。`);
  process.exit(1);
}

// 按外键顺序排列；导出文件里未列出的表追加在后。
const present = Object.keys(payload.tables);
const ordered = [
  ...TABLE_ORDER.filter((name) => present.includes(name)),
  ...present.filter((name) => !TABLE_ORDER.includes(name)),
];

if (args.dryRun) {
  for (const table of ordered) {
    console.log(`${table}: ${payload.tables[table].length} 行`);
  }
  const total = ordered.reduce((sum, table) => sum + payload.tables[table].length, 0);
  console.log(`共 ${ordered.length} 张表、${total} 行（dry-run，未写入）`);
  process.exit(0);
}

const db = openStore(targetPath, { type: 'sqlite' });
try {
  db.exec('PRAGMA foreign_keys = OFF');
  db.transaction(() => {
    for (const table of ordered) {
      const rows = payload.tables[table];
      for (const row of rows) {
        const columns = Object.keys(row);
        if (columns.length === 0) continue;
        const placeholders = columns.map(() => '?').join(', ');
        db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`)
          .run(...columns.map((column) => row[column]));
      }
    }
  });
  db.exec('PRAGMA foreign_keys = ON');

  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length > 0) {
    console.error(`导入完成但存在 ${violations.length} 条外键不一致，请检查导出文件`);
    process.exit(2);
  }

  const total = ordered.reduce((sum, table) => sum + payload.tables[table].length, 0);
  console.log(`已导入 ${ordered.length} 张表、${total} 行 → ${targetPath}`);
} catch (error) {
  console.error(`导入失败，已回滚：${error.message}`);
  process.exit(1);
} finally {
  db.close();
}
