#!/usr/bin/env node
// 数据导出（F 枝）：把当前库按表导出为 JSON，供迁移到其它数据库前留档或校验。
// 用法：
//   node center/bin/export-data.mjs --out dump.json [--table tasks] [--db <path>]

import fs from 'node:fs';
import path from 'node:path';
import { openStore } from '../src/db/store.mjs';
import { resolveConfig } from '../src/config.mjs';

function parseArgs(argv) {
  const args = { tables: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--out') { args.out = argv[i + 1]; i += 1; }
    else if (token === '--table') { args.tables.push(argv[i + 1]); i += 1; }
    else if (token === '--db') { args.db = argv[i + 1]; i += 1; }
    else if (token === '--help' || token === '-h') { args.help = true; }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.out) {
  console.log('用法：node center/bin/export-data.mjs --out <file.json> [--table <name>] [--db <path>]');
  process.exit(args.help ? 0 : 1);
}

const resolved = resolveConfig();
const dbPath = args.db || resolved.db.path;
const db = openStore(dbPath, { type: 'sqlite', migrate: false });

try {
  const allTables = db.listTables();
  const selected = args.tables.length > 0 ? args.tables : allTables;
  const unknown = selected.filter((name) => !allTables.includes(name));
  if (unknown.length > 0) {
    console.error(`未知的表：${unknown.join(', ')}`);
    process.exit(1);
  }

  const data = {};
  const counts = {};
  for (const table of selected) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    data[table] = rows;
    counts[table] = rows.length;
  }

  const payload = {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    dialect: db.type,
    source_path: path.resolve(dbPath),
    tables: data,
  };

  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  console.log(`已导出 ${selected.length} 张表、${total} 行 → ${path.resolve(args.out)}`);
} finally {
  db.close();
}
