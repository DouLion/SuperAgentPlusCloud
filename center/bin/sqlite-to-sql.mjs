#!/usr/bin/env node
// DDL 草案生成（F 枝）：把当前 SQLite 结构转成通用 SQL 草案，供迁移评估。
// 用法：node center/bin/sqlite-to-sql.mjs [--out schema-draft.sql]

import fs from 'node:fs';
import path from 'node:path';
import { openStore } from '../src/db/store.mjs';
import { resolveConfig } from '../src/config.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--out') { args.out = argv[i + 1]; i += 1; }
    else if (token === '--db') { args.db = argv[i + 1]; i += 1; }
    else if (token === '--help' || token === '-h') { args.help = true; }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('用法：node center/bin/sqlite-to-sql.mjs [--out <file.sql>] [--db <path>]');
  process.exit(0);
}

const resolved = resolveConfig();
const dbPath = args.db || resolved.db.path;
const db = openStore(dbPath, { type: 'sqlite', migrate: false });

try {
  const rows = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();

  const lines = [
    '-- SuperAgentPlus DDL 草案（由 SQLite 结构生成）',
    `-- 生成时间：${new Date().toISOString()}`,
    '--',
    '-- 重要：本文件仅为草案。',
    '--  1) 类型只做了 TEXT / INTEGER 的基本映射，未按目标库优化；',
    '--  2) 索引、CHECK 约束、部分唯一索引需要人工复核；',
    '--  3) 外键与级联行为请按目标库语法重写；',
    '--  4) 时间字段统一为应用层 ISO 字符串，未使用数据库原生时间类型。',
    '',
  ];

  for (const row of rows) {
    const sql = String(row.sql || '')
      .replace(/\bAUTOINCREMENT\b/gi, '')
      .replace(/\bBLOB\b/gi, 'TEXT')
      .replace(/\bREAL\b/gi, 'TEXT');
    lines.push(`-- ${row.name}`, `${sql};`, '');
  }

  const text = `${lines.join('\n')}\n`;
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(path.resolve(args.out), text, 'utf8');
    console.log(`DDL 草案已写入：${path.resolve(args.out)}（${rows.length} 张表，需人工复核）`);
  } else {
    process.stdout.write(text);
  }
} finally {
  db.close();
}
