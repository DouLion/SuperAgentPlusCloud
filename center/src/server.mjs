// Center HTTP 路由（T2）：需求、评估、决定，以及项目与主干条目查询。
// 只依赖 node:http 与 store.mjs；JSON 请求体解析与错误响应在此集中处理。

import http from 'node:http';
import {
  createProject,
  listProjects,
  createTrunkItem,
  listTrunkItems,
  createRequirement,
  getRequirement,
  listRequirements,
  createAssessment,
  listAssessments,
  createDecision,
  listDecisions,
  listRequirementTimeline,
} from './store.mjs';

/** 把 pathname 按 '/' 切分，忽略结尾斜杠。 */
function segments(pathname) {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return trimmed.split('/').filter((part) => part !== '');
}

/**
 * 匹配路由。返回 { route, params, pathMatched }：
 * pathMatched 为真表示路径存在但方法不符（用于 405）。
 */
function matchRoute(routeList, method, pathname) {
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

  {
    method: 'GET',
    pattern: '/projects',
    handler: ({ url, db }) => {
      const status = url.searchParams.get('status');
      return listProjects(db, status ? { status } : {});
    },
  },
  {
    method: 'POST',
    pattern: '/projects',
    handler: ({ body, db }) => ({ status: 201, body: createProject(db, body) }),
  },

  {
    method: 'GET',
    pattern: '/trunk-items',
    handler: ({ url, db }) => {
      const query = {};
      for (const key of ['project_id', 'status', 'kind']) {
        const value = url.searchParams.get(key);
        if (value) query[key] = value;
      }
      return listTrunkItems(db, query);
    },
  },
  {
    method: 'POST',
    pattern: '/trunk-items',
    handler: ({ body, db }) => ({ status: 201, body: createTrunkItem(db, body) }),
  },

  {
    method: 'GET',
    pattern: '/requirements',
    handler: ({ url, db }) => {
      const query = {};
      for (const key of ['project_id', 'status']) {
        const value = url.searchParams.get(key);
        if (value) query[key] = value;
      }
      return listRequirements(db, query);
    },
  },
  {
    method: 'POST',
    pattern: '/requirements',
    handler: ({ body, db }) => ({ status: 201, body: createRequirement(db, body) }),
  },

  {
    method: 'GET',
    pattern: '/requirements/:id',
    handler: ({ params, db }) => {
      const requirement = getRequirement(db, params.id);
      if (!requirement) {
        return { status: 404, body: { ok: false, error: `需求不存在：${params.id}` } };
      }
      return requirement;
    },
  },
  {
    method: 'GET',
    pattern: '/requirements/:id/assessments',
    handler: ({ params, db }) => listAssessments(db, params.id),
  },
  {
    method: 'GET',
    pattern: '/requirements/:id/decisions',
    handler: ({ params, db }) => listDecisions(db, params.id),
  },
  {
    method: 'GET',
    pattern: '/requirements/:id/timeline',
    handler: ({ params, db }) => listRequirementTimeline(db, params.id),
  },
  {
    method: 'POST',
    pattern: '/requirements/:id/assessments',
    handler: ({ params, body, db }) => ({
      status: 201,
      body: createAssessment(db, { ...body, requirement_id: params.id }),
    }),
  },
  {
    method: 'POST',
    pattern: '/requirements/:id/decision',
    handler: ({ params, body, db }) => ({
      status: 201,
      body: createDecision(db, { ...body, requirement_id: params.id }),
    }),
  },
];

function sendJson(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    ...extraHeaders,
  });
  res.end(data);
}

/** 读取并解析 JSON body；无 body 返回空对象，非法 JSON 抛错。 */
function readJsonBody(req) {
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
function statusForError(err) {
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
      sendJson(res, statusForError(err), {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
