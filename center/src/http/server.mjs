// Center HTTP 服务（T7 归置）。
// 负责路由匹配、JSON 收发、错误映射与服务创建；具体路由见 ./routes/*。

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WEB_DIST } from '../config.mjs';
import { ROUTES as PROJECT_ROUTES } from './routes/projects.mjs';
import { ROUTES as TRUNK_ROUTES } from './routes/trunk.mjs';
import { ROUTES as CHANGE_ROUTES } from './routes/changes.mjs';
import { ROUTES as REQUIREMENT_ROUTES } from './routes/requirements.mjs';
import { ROUTES as TASK_ROUTES } from './routes/tasks.mjs';
import { ROUTES as SUBMISSION_ROUTES } from './routes/submissions.mjs';
import { ROUTES as AI_ROUTES } from './routes/ai.mjs';
import { ROUTES as EVENT_ROUTES } from './routes/events.mjs';
import { ROUTES as SETUP_ROUTES } from './routes/setup.mjs';

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
  ...AI_ROUTES,
  ...EVENT_ROUTES,
  ...SETUP_ROUTES,
];

/** 面板与接口的统一前缀（见 docs/08 §1）。 */
export const API_PREFIX = '/sap-cloud/api';
export const APP_PREFIX = '/sap-cloud';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** 未构建前端时的友好提示页。 */
const FRIENDLY_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8" /><title>SuperAgentPlus 面板</title></head>
<body style="font-family:system-ui,'Microsoft YaHei',sans-serif;background:#f5f7fa;color:#303133;margin:0;display:flex;align-items:center;justify-content:center;height:100vh">
  <div style="max-width:560px;background:#fff;border:1px solid #e4e7ed;border-radius:8px;padding:28px 32px">
    <h1 style="font-size:20px;margin:0 0 12px">SuperAgentPlus 面板尚未构建</h1>
    <p style="color:#606266;line-height:1.8">Center 已启动，但还没有前端构建产物。请先执行：</p>
    <pre style="background:#f5f7fa;padding:10px 12px;border-radius:6px;font-size:13px">npm --prefix web install
npm --prefix web run build</pre>
    <p style="color:#909399;font-size:13px;line-height:1.8">构建后刷新本页面即可打开面板；接口位于 <code>/sap-cloud/api/*</code>，不受影响。</p>
  </div>
</body>
</html>`;

/** 把 URL pathname 解析为 WEB_DIST 内的安全相对路径；越界返回 null。 */
function resolveSafePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const normalized = path.normalize(decoded).replace(/^[/\\]+/, '');
  if (normalized.includes('\0')) return null;
  const resolved = path.resolve(WEB_DIST, normalized);
  if (resolved !== WEB_DIST && !resolved.startsWith(WEB_DIST + path.sep)) return null;
  return resolved;
}

function writeHtml(res, status, html) {
  const data = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-cache',
  });
  res.end(data);
}

/** 前端页面路径：这些路径同时存在 API 路由，浏览器导航时优先返回 SPA。 */
const SPA_PAGE_PATHS = ['/projects', '/requirements', '/tasks', '/setup', '/settings'];
const SPA_PAGE_PREFIXES = [
  '/project/',
  '/trunk/',
  '/changes/',
  '/timeline/',
  '/requirements/',
  '/tasks/',
];

function isSpaPagePath(pathname) {
  return SPA_PAGE_PATHS.includes(pathname)
    || SPA_PAGE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function acceptsHtml(accept) {
  return String(accept || '').includes('text/html');
}

/** 返回 index.html；构建产物缺失时返回友好提示页。 */
function serveIndexPage(res, method) {
  const indexFile = path.join(WEB_DIST, 'index.html');
  if (fs.existsSync(indexFile)) {
    const data = fs.readFileSync(indexFile);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': data.length,
      'cache-control': 'no-cache',
    });
    res.end(method === 'HEAD' ? undefined : data);
    return true;
  }
  writeHtml(res, 200, FRIENDLY_HTML);
  return true;
}

/**
 * 静态托管：命中静态文件返回文件；未命中的浏览器导航回落到 index.html。
 * 返回 true 表示已处理响应；false 表示应继续走 API 的 404/405 JSON。
 */
function serveStatic(res, pathname, accept, method) {
  const isRoot = pathname === '/';

  if (!fs.existsSync(WEB_DIST)) {
    if (isRoot || acceptsHtml(accept)) {
      writeHtml(res, 200, FRIENDLY_HTML);
      return true;
    }
    return false;
  }

  const file = resolveSafePath(pathname);
  if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const data = fs.readFileSync(file);
    res.writeHead(200, {
      'content-type': MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': data.length,
      'cache-control': path.extname(file).toLowerCase() === '.html'
        ? 'no-cache'
        : 'public, max-age=3600',
    });
    res.end(method === 'HEAD' ? undefined : data);
    return true;
  }

  // SPA history 路由：仅浏览器导航回落到 index.html，接口请求仍走 404 JSON。
  if (isRoot || acceptsHtml(accept)) {
    return serveIndexPage(res, method);
  }
  return false;
}

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

/** 308 永久重定向：用于旧路径迁移到新前缀。 */
function sendRedirect(res, location) {
  res.writeHead(308, { location, 'content-length': 0 });
  res.end();
}

/** 构造仅替换 pathname、保留 query 的 URL 视图，供 handler 使用。 */
function withPathname(rawUrl, pathname) {
  const next = new URL(rawUrl.toString());
  next.pathname = pathname;
  return next;
}

/** 处理已剥掉 API 前缀的请求；返回 true 表示已响应。 */
async function handleApiRequest(req, res, routes, db, url, pathForMessage) {
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
        path: pathForMessage,
      },
      headers,
    );
    return true;
  }

  // 浏览器直接刷新「页面与 API 同名」的路径时优先返回 SPA；
  // 前端 fetch 的 Accept 为 */*，仍走下面的 API 路由。
  if (req.method === 'GET' && isSpaPagePath(url.pathname) && acceptsHtml(req.headers.accept)) {
    serveIndexPage(res, req.method);
    return true;
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
  return true;
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
      const rawUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const { pathname } = rawUrl;

      // 1) 站点根：迁到面板基址。
      if (pathname === '/') {
        sendRedirect(res, `${APP_PREFIX}/`);
        return;
      }

      // 2) 新 API 前缀：剥前缀后按原路由匹配，query 保留。
      if (pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`)) {
        const apiPath = pathname.slice(API_PREFIX.length) || '/';
        await handleApiRequest(req, res, routes, db, withPathname(rawUrl, apiPath), apiPath);
        return;
      }

      // 3) 新面板前缀：剥前缀后走静态托管与 SPA 回落。
      if (pathname === APP_PREFIX || pathname.startsWith(`${APP_PREFIX}/`)) {
        const appPath = pathname.slice(APP_PREFIX.length) || '/';
        if (req.method === 'GET' || req.method === 'HEAD') {
          if (serveStatic(res, appPath, req.headers.accept, req.method)) return;
          sendJson(res, 404, { ok: false, error: 'not_found', method: req.method, path: appPath });
          return;
        }
        sendJson(res, 405, {
          ok: false,
          error: 'method_not_allowed',
          method: req.method,
          path: appPath,
        });
        return;
      }

      // 4) 旧路径：API 与页面分别迁移；写操作给出明确提示。
      const legacy = matchRoute(routes, req.method, pathname);
      const isApiPath = Boolean(legacy.route) || legacy.pathMatched;
      const isPagePath = !isApiPath && isSpaPagePath(pathname);

      if (isApiPath) {
        if (req.method === 'GET' || req.method === 'HEAD') {
          // 同一路径既是旧 API 又是旧页面时（如 /requirements）：
          // 浏览器导航去面板，接口调用去 API。
          const target = acceptsHtml(req.headers.accept) && isSpaPagePath(pathname)
            ? `${APP_PREFIX}${pathname}`
            : `${API_PREFIX}${pathname}`;
          sendRedirect(res, target);
          return;
        }
        sendJson(res, 410, {
          ok: false,
          error: '接口已迁移到 /sap-cloud/api，请使用新路径',
          code: 'API_PREFIX_REQUIRED',
          path: pathname,
        });
        return;
      }

      if (isPagePath && (req.method === 'GET' || req.method === 'HEAD')) {
        sendRedirect(res, `${APP_PREFIX}${pathname}`);
        return;
      }

      sendJson(res, 404, {
        ok: false,
        error: 'not_found',
        method: req.method,
        path: pathname,
      });
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
