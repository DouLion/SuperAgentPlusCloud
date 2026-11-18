// Center HTTP 服务（T7 归置）。
// 负责路由匹配、JSON 收发、错误映射与服务创建；具体路由见 ./routes/*。

import http from 'node:http';
import { ROUTES as PROJECT_ROUTES } from './routes/projects.mjs';
import { ROUTES as TRUNK_ROUTES } from './routes/trunk.mjs';
import { ROUTES as CHANGE_ROUTES } from './routes/changes.mjs';
import { ROUTES as REQUIREMENT_ROUTES } from './routes/requirements.mjs';
import { ROUTES as TASK_ROUTES } from './routes/tasks.mjs';
import { ROUTES as SUBMISSION_ROUTES } from './routes/submissions.mjs';

/** 把 pathname 按 '/' 切分，忽略结尾斜杠。 */
export function segments(pathname) {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return trimmed.split('/').filter((part) => part !== '');
}

/**
 * 匹配路由。返回 { route, params, pathMatched }：
 * pathMatched 为真表示路径存在但方法不符（用于 405）。
 */
export function matchRoute(routeList, method, pathname) {
  const parts = segments(pathname);
  const allowed = new Set();
  let route = null;
  let params = {};

  for (const candidate of routeList) {
    const patternParts = segments(candidate.pattern);
    if (patternParts.length !== parts.length) continue;

    const matched = {};
    let ok = true;
    for (let i = 0; i < patternParts.length; i += 1) {
      const patternPart = patternParts[i];
      if (patternPart.startsWith(':')) {
        matched[patternPart.slice(1)] = decodeURIComponent(parts[i]);
      } else if (patternPart !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    allowed.add(candidate.method);
    if (candidate.method === method) {
      route = candidate;
      params = matched;
    }
  }

  return { route, params, allowed: [...allowed], pathMatched: route === null && allowed.size > 0 };
}

/**
 * 路由表。handler 接收 { url, body, params, db }，
 * 返回对象（200）或 { status, body }。
 */
export const ROUTES = [
  { method: 'GET', pattern: '/healthz', handler: () => ({ ok: true }) },
  ...PROJECT_ROUTES,
  ...TRUNK_ROUTES,
  ...CHANGE_ROUTES,
  ...REQUIREMENT_ROUTES,
  ...TASK_ROUTES,
  ...SUBMISSION_ROUTES,
];

export function sendJson(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    ...extraHeaders,
  });
  res.end(data);
}

/** 读取并解析 JSON body；无 body 返回空对象，非法 JSON 抛错。 */
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 业务校验错误返回 400，其余 500；带 status 的错误按 status 返回。 */
export function statusForError(err) {
  if (err && Number.isInteger(err.status)) return err.status;
  const message = err instanceof Error ? err.message : String(err);
  if (/JSON/.test(message)) return 400;
  if (/非法|缺少|不存在|必填|必须|不能|无法/.test(message)) return 400;
  return 500;
}

/**
 * 创建 Center HTTP 服务。
 * @param {import('node:sqlite').DatabaseSync} db 已打开的数据库
 * @param {object} [options] 预留：{ routes }
 * @returns {import('node:http').Server}
 */
export function createServer(db, options = {}) {
  const routes = options.routes ?? ROUTES;

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const { route, params, allowed, pathMatched } = matchRoute(routes, req.method, url.pathname);

      if (!route) {
        const headers = pathMatched && allowed.length > 0 ? { allow: allowed.join(', ') } : {};
        sendJson(
          res,
          pathMatched ? 405 : 404,
          {
            ok: false,
            error: pathMatched ? 'method_not_allowed' : 'not_found',
            method: req.method,
            path: url.pathname,
          },
          headers,
        );
        return;
      }

      const body = await readJsonBody(req);
      const result = await route.handler({ req, url, body, params, db });

      // 只有显式给出数字 status 且带 body 才视为响应包装；
      // 否则视为普通数据行（业务行可能自身含有 status 字段）。
      if (
        result
        && typeof result.status === 'number'
        && Object.prototype.hasOwnProperty.call(result, 'body')
      ) {
        sendJson(res, result.status, result.body);
      } else {
        sendJson(res, 200, result);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, statusForError(err), {
        ok: false,
        error: message,
        ...(err && typeof err.code === 'string' ? { code: err.code } : {}),
      });
    }
  });
}
