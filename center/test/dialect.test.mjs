// 方言层测试（F 枝）：接口形状、事务与嵌套回滚、未实现类型报错。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openStore } from '../src/db/store.mjs';
import { createDialect } from '../src/db/dialect.mjs';

function tmpFile(name) {
  return path.join(os.tmpdir(), `${name}-${process.pid}-${Date.now()}.db`);
}

test('方言接口：type / prepare / exec / transaction 可用', () => {
  const file = tmpFile('dialect-shape');
  const db = openStore(file);
  try {
    assert.equal(db.type, 'sqlite');
    assert.equal(db.dialect, db);
    assert.equal(typeof db.placeholder, 'function');
    assert.equal(db.placeholder(1), '?');
    assert.equal(db.jsonType(), 'TEXT');
    assert.equal(db.supportsReturning, false);

    db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, name TEXT)');
    db.prepare('INSERT INTO t (name) VALUES (?)').run('a');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 1);
    assert.deepEqual(db.prepare('SELECT name FROM t').all().map((r) => r.name), ['a']);
  } finally {
    db.close();
    fs.rmSync(file, { force: true });
  }
});

test('transaction：成功提交，抛错回滚', () => {
  const file = tmpFile('dialect-tx');
  const db = openStore(file);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, name TEXT)');
    db.transaction(() => {
      db.prepare('INSERT INTO t (name) VALUES (?)').run('ok');
    });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 1);

    assert.throws(() => {
      db.transaction(() => {
        db.prepare('INSERT INTO t (name) VALUES (?)').run('bad');
        throw new Error('boom');
      });
    }, /boom/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 1);
  } finally {
    db.close();
    fs.rmSync(file, { force: true });
  }
});

test('transaction：嵌套用保存点，内层回滚不影响外层', () => {
  const file = tmpFile('dialect-nested');
  const db = openStore(file);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, name TEXT)');
    db.transaction(() => {
      db.prepare('INSERT INTO t (name) VALUES (?)').run('outer');
      assert.throws(() => {
        db.transaction(() => {
          db.prepare('INSERT INTO t (name) VALUES (?)').run('inner');
          throw new Error('inner-fail');
        });
      }, /inner-fail/);
      db.prepare('INSERT INTO t (name) VALUES (?)').run('after');
    });
    const names = db.prepare('SELECT name FROM t ORDER BY id').all().map((r) => r.name);
    assert.deepEqual(names, ['outer', 'after']);
  } finally {
    db.close();
    fs.rmSync(file, { force: true });
  }
});

test('未实现的数据库类型：明确拒绝', () => {
  assert.throws(
    () => createDialect({ type: 'postgres', database: 'ignored' }),
    (error) => error.code === 'UNSUPPORTED_DB_TYPE',
  );
  assert.throws(
    () => openStore(tmpFile('dialect-pg'), { type: 'mysql' }),
    (error) => error.code === 'UNSUPPORTED_DB_TYPE',
  );
});
