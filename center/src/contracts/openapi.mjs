// OpenAPI 3.1 契约（T13）：确定性校验、文档渲染与 Mock 生成。

import { listConventionPacks } from '../db/conventions.mjs';
import { codedError } from '../db/json.mjs';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'];
const DEFAULT_FORBIDDEN = [];

function pointer(...parts) {
  return `/${parts.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}

function ruleValue(rule) {
  return rule && typeof rule.value === 'object' && rule.value !== null ? rule.value : {};
}

/** 项目当前 active 约定规则；项目快照是唯一输入，不自动追随团队模板。 */
export function activeConventionRules(db, projectId) {
  return listConventionPacks(db, { project_id: projectId, status: 'active' })
    .flatMap((pack) => (pack.rules || []).map((rule) => ({ ...rule, pack_id: pack.pack_id })));
}

function supportedRule(rules, keys) {
  return rules.find((rule) => keys.includes(rule.key));
}

function violation(rule, message, location, fallbackSeverity = 'must') {
  return {
    key: rule?.key ?? 'openapi.structure',
    severity: rule?.severity ?? fallbackSeverity,
    title: rule?.title ?? 'OpenAPI 结构校验',
    message,
    pointer: location,
    pack_id: rule?.pack_id ?? null,
  };
}

function isKebabPath(pathname) {
  return pathname.split('/').filter(Boolean).every((segment) => (
    /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(segment)
    || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment)
  ));
}

function isCamel(name) {
  return /^[a-z][A-Za-z0-9]*$/.test(name) && !name.includes('_') && !name.includes('-');
}

function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  return ref.slice(2).split('/').reduce((value, key) => value?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], root);
}

function dereference(schema, root) {
  return schema?.$ref ? resolveRef(root, schema.$ref) : schema;
}

function visitRefs(value, root, violations, location = '') {
  if (!value || typeof value !== 'object') return;
  if (typeof value.$ref === 'string' && value.$ref.startsWith('#/') && !resolveRef(root, value.$ref)) {
    violations.push(violation(null, `引用不存在：${value.$ref}`, `${location}/$ref`));
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visitRefs(entry, root, violations, `${location}/${index}`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== '$ref') visitRefs(child, root, violations, `${location}/${key}`);
  }
}

function walkProperties(schema, visit, location = '', root = schema) {
  const resolved = dereference(schema, root);
  if (!resolved || typeof resolved !== 'object') return;
  if (resolved.properties && typeof resolved.properties === 'object') {
    for (const [name, child] of Object.entries(resolved.properties)) {
      visit(name, child, `${location}/properties/${name}`);
      walkProperties(child, visit, `${location}/properties/${name}`, root);
    }
  }
  if (resolved.items) walkProperties(resolved.items, visit, `${location}/items`, root);
  for (const key of ['allOf', 'oneOf', 'anyOf']) {
    if (Array.isArray(resolved[key])) resolved[key].forEach((entry, i) => walkProperties(entry, visit, `${location}/${key}/${i}`, root));
  }
}

/** 校验 OpenAPI 结构与项目 active 约定。must 违规决定是否可发布。 */
export function validateOpenApi(contract, rules = []) {
  const violations = [];
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    return { valid: false, violations: [violation(null, '契约必须是 JSON 对象', '/')], operations: [] };
  }
  if (typeof contract.openapi !== 'string' || !contract.openapi.startsWith('3.1')) {
    violations.push(violation(null, 'openapi 必须是 3.1.x', '/openapi'));
  }
  if (!contract.info?.title || !contract.info?.version) {
    violations.push(violation(null, 'info.title 与 info.version 必填', '/info'));
  }
  if (!contract.paths || typeof contract.paths !== 'object' || Array.isArray(contract.paths)) {
    violations.push(violation(null, 'paths 必须是对象', '/paths'));
  }
  visitRefs(contract, contract, violations, '');

  const forbiddenRule = supportedRule(rules, ['api.methods.forbidden', 'api.method.forbidden', 'api.forbidden-methods']);
  const forbiddenValue = forbiddenRule?.value;
  const forbidden = new Set((Array.isArray(forbiddenValue)
    ? forbiddenValue
    : ruleValue(forbiddenRule).methods ?? DEFAULT_FORBIDDEN).map((method) => String(method).toLowerCase()));
  const envelopeRule = supportedRule(rules, ['api.response', 'api.response.envelope']);
  const envelopeValue = ruleValue(envelopeRule);
  const envelopeFields = envelopeValue.fields ?? envelopeValue.required ?? [];
  const pathRule = supportedRule(rules, ['api.path.case']);
  const fieldRule = supportedRule(rules, ['api.field.case']);
  const operationIds = new Map();
  const operations = [];

  for (const [pathname, pathItem] of Object.entries(contract.paths || {})) {
    if (!pathname.startsWith('/')) violations.push(violation(null, '路径必须以 / 开头', pointer('paths', pathname)));
    const pathStyle = typeof pathRule?.value === 'string' ? pathRule.value : ruleValue(pathRule).style;
    if (pathRule && pathStyle === 'kebab-case' && !isKebabPath(pathname)) {
      violations.push(violation(pathRule, `路径不符合 kebab-case：${pathname}`, pointer('paths', pathname)));
    }
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;
      const location = pointer('paths', pathname, method);
      const operationId = operation.operationId;
      operations.push({ pathname, method, operationId: operationId ?? null });
      if (!operationId) {
        violations.push(violation(null, `${method.toUpperCase()} ${pathname} 缺少 operationId`, location));
      } else if (operationIds.has(operationId)) {
        violations.push(violation(null, `operationId 重复：${operationId}`, `${location}/operationId`));
      } else operationIds.set(operationId, location);

      if (forbidden.has(method)) {
        violations.push(violation(forbiddenRule, `项目约定禁止 ${method.toUpperCase()} 请求`, location));
      }

      const responses = operation.responses || {};
      for (const [status, response] of Object.entries(responses)) {
        if (!/^2\d\d$/.test(status)) continue;
        const media = response?.content?.['application/json'];
        if (!media?.schema || !envelopeRule || envelopeFields.length === 0) continue;
        const responseSchema = dereference(media.schema, contract) || {};
        const required = new Set(responseSchema.required || []);
        const props = responseSchema.properties || {};
        for (const field of envelopeFields) {
          if (!required.has(field) || !Object.prototype.hasOwnProperty.call(props, field)) {
            violations.push(violation(
              envelopeRule,
              `响应 ${status} 必须包含必填字段 ${field}`,
              `${location}/responses/${status}/content/application~1json/schema`,
            ));
          }
        }
      }
    }
  }

  const fieldStyle = typeof fieldRule?.value === 'string' ? fieldRule.value : ruleValue(fieldRule).style;
  if (fieldRule && fieldStyle === 'camelCase') {
    walkProperties({ type: 'object', properties: contract.components?.schemas || {} }, (name, _schema, location) => {
      // schema 名称不是 JSON 字段；只校验 schema 内的 properties。
      if (location.split('/properties/').length <= 2) return;
      if (!isCamel(name)) violations.push(violation(fieldRule, `字段不符合 camelCase：${name}`, `/components/schemas${location.replace(/^\/properties/, '')}`));
    }, '', contract);
  }

  const counts = { must: 0, should: 0, preference: 0 };
  for (const item of violations) counts[item.severity] = (counts[item.severity] || 0) + 1;
  return { valid: counts.must === 0, counts, violations, operations };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** 从同一份契约渲染只读 HTML 文档，不产生第二份事实。 */
export function renderOpenApiHtml(contract, validation = validateOpenApi(contract, [])) {
  const rows = validation.operations.map(({ method, pathname, operationId }) => {
    const op = contract.paths[pathname][method];
    const responses = Object.keys(op.responses || {}).join(', ') || '—';
    return `<tr><td><code>${escapeHtml(method.toUpperCase())}</code></td><td><code>${escapeHtml(pathname)}</code></td><td>${escapeHtml(operationId || '—')}</td><td>${escapeHtml(op.summary || op.description || '—')}</td><td>${escapeHtml(responses)}</td></tr>`;
  }).join('');
  const issues = validation.violations.map((item) => `<li><strong>${escapeHtml(item.severity)}</strong> ${escapeHtml(item.message)} <code>${escapeHtml(item.pointer)}</code></li>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(contract.info?.title || 'API 契约')}</title><style>body{font-family:system-ui,'Microsoft YaHei';max-width:1100px;margin:32px auto;padding:0 20px;color:#303133}table{width:100%;border-collapse:collapse}th,td{border:1px solid #dcdfe6;padding:9px;text-align:left}th{background:#f5f7fa}code{background:#f4f4f5;padding:2px 5px;border-radius:3px}.ok{color:#67c23a}.bad{color:#f56c6c}</style></head><body><h1>${escapeHtml(contract.info?.title || 'API 契约')}</h1><p>版本：${escapeHtml(contract.info?.version || '—')}　OpenAPI：${escapeHtml(contract.openapi || '—')}</p><p class="${validation.valid ? 'ok' : 'bad'}">确定性校验：${validation.valid ? '通过' : `未通过（must ${validation.counts?.must || 0}）`}</p>${issues ? `<h2>校验结果</h2><ul>${issues}</ul>` : ''}<h2>接口</h2><table><thead><tr><th>方法</th><th>路径</th><th>operationId</th><th>说明</th><th>响应</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

export function exampleFromSchema(schema, root, seen = new Set()) {
  if (!schema || typeof schema !== 'object') return null;
  if ('$ref' in schema) {
    if (seen.has(schema.$ref)) return null;
    const nextSeen = new Set(seen).add(schema.$ref);
    return exampleFromSchema(resolveRef(root, schema.$ref), root, nextSeen);
  }
  if ('example' in schema) return schema.example;
  if ('const' in schema) return schema.const;
  if ('default' in schema) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.type === 'object' || schema.properties) {
    return Object.fromEntries(Object.entries(schema.properties || {}).map(([key, child]) => [key, exampleFromSchema(child, root, seen)]));
  }
  if (schema.type === 'array') return [exampleFromSchema(schema.items || {}, root, seen)];
  if (schema.type === 'integer' || schema.type === 'number') return 0;
  if (schema.type === 'boolean') return false;
  return 'string';
}

function pathPatternMatch(template, actual) {
  const names = [];
  const escaped = template.split('/').map((segment) => {
    const match = /^\{([^}]+)\}$/.exec(segment);
    if (match) { names.push(match[1]); return '([^/]+)'; }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  const match = new RegExp(`^${escaped}/?$`).exec(actual);
  if (!match) return null;
  return Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
}

/** 按真实 method/path 从契约生成示例响应。 */
export function mockFromContract(contract, method, requestPath) {
  const lower = String(method).toLowerCase();
  for (const [template, pathItem] of Object.entries(contract.paths || {})) {
    const params = pathPatternMatch(template, requestPath);
    if (!params || !pathItem[lower]) continue;
    const operation = pathItem[lower];
    const entries = Object.entries(operation.responses || {});
    const selected = entries.find(([status]) => /^2\d\d$/.test(status)) || entries[0];
    if (!selected) throw codedError('MOCK_RESPONSE_MISSING', '契约没有定义响应', 422);
    const [statusText, response] = selected;
    const media = response?.content?.['application/json'];
    const examples = media?.examples && typeof media.examples === 'object'
      ? Object.values(media.examples)
      : [];
    const body = media?.example ?? examples[0]?.value;
    return {
      status: /^\d{3}$/.test(statusText) ? Number(statusText) : 200,
      body: body ?? exampleFromSchema(media?.schema || {}, contract),
      operation_id: operation.operationId ?? null,
      path_params: params,
    };
  }
  throw Object.assign(new Error(`Mock 未找到接口：${String(method).toUpperCase()} ${requestPath}`), {
    status: 404, code: 'MOCK_OPERATION_NOT_FOUND',
  });
}
