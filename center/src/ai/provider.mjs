// Center 模型接入（T8）：OpenAI 兼容的 POST /chat/completions。
// 零第三方依赖，使用 Node 内置 fetch；只负责请求、超时、错误归类与 JSON 容错提取。

import { codedError } from '../db/json.mjs';
import { aiConfigured, llmConfig } from '../config.mjs';

/** 从文本中裁掉代码块围栏。 */
function stripFence(text) {
  const fenced = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1].trim() !== '') return fenced[1].trim();
  return text;
}

/** 从 start 位置开始找配平的括号终点（忽略字符串内的括号）。 */
function matchBalanced(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 容错提取 JSON：先整体解析，再去代码块围栏，最后尝试第一个配平的 {…} / […]。
 * @returns {any|null} 解析结果；无法提取返回 null
 */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // 继续尝试容错提取
  }

  const unfenced = stripFence(trimmed);
  if (unfenced !== trimmed) {
    try {
      return JSON.parse(unfenced);
    } catch {
      // 继续尝试配平截取
    }
  }

  const first = unfenced.search(/[[{]/);
  if (first === -1) return null;

  const candidate = unfenced.slice(first);
  for (let start = 0; start < candidate.length; start += 1) {
    const ch = candidate[start];
    if (ch !== '{' && ch !== '[') continue;
    const end = matchBalanced(candidate, start);
    if (end === -1) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // 尝试下一个起始位置
    }
  }
  return null;
}

/** 构造 AI 相关错误。 */
function aiError(code, message) {
  const status = code === 'AI_NOT_CONFIGURED' ? 503 : 502;
  return codedError(code, message, status);
}

/**
 * 发起一次模型对话。
 * @param {object} options
 * @param {string} options.system 系统提示词
 * @param {string} options.user 用户提示词
 * @param {boolean} [options.responseFormatJson=true] 是否要求并解析 JSON
 * @returns {Promise<any>} responseFormatJson 为真时返回解析后的对象/数组，否则返回原始文本
 */
export async function chat({ system, user, responseFormatJson = true } = {}) {
  const { data } = await chatWithRaw({ system, user, responseFormatJson });
  return data;
}

/**
 * 同 chat，但额外返回模型原始 content，供建议留档。
 * @returns {Promise<{ data: any, raw: string }>}
 */
export async function chatWithRaw({ system, user, responseFormatJson = true } = {}) {
  if (!aiConfigured()) {
    throw aiError(
      'AI_NOT_CONFIGURED',
      'Center 未配置模型：请设置 SAP_LLM_BASE_URL 与 SAP_LLM_API_KEY',
    );
  }

  const { base_url: baseUrl, api_key: apiKey, model, timeout_ms: timeoutMs } = llmConfig();
  const root = baseUrl.replace(/\/+$/, '');
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    ...(responseFormatJson ? { response_format: { type: 'json_object' } } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await globalThis.fetch(`${root}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw aiError('AI_REQUEST_FAILED', `模型请求超时（${timeoutMs}ms）`);
    }
    throw aiError('AI_REQUEST_FAILED', `模型请求失败：${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.text()).trim();
    } catch {
      detail = '';
    }
    throw aiError(
      'AI_REQUEST_FAILED',
      `模型服务返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`,
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw aiError('AI_BAD_RESPONSE', '模型响应不是合法 JSON');
  }

  const content = payload && payload.choices && payload.choices[0]
    && payload.choices[0].message
    ? payload.choices[0].message.content
    : undefined;
  if (typeof content !== 'string') {
    throw aiError('AI_BAD_RESPONSE', '模型响应缺少 choices[0].message.content');
  }

  if (!responseFormatJson) {
    return { data: content, raw: content };
  }

  const data = extractJson(content);
  if (data === null) {
    // 把原始 content 挂在错误上，便于上层留档（解析失败也要能看到原文）。
    throw Object.assign(aiError('AI_BAD_RESPONSE', '无法从模型响应中提取 JSON'), {
      raw: content,
    });
  }
  return { data, raw: content };
}
