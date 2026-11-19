// 协议版本（P3）：请求头协商 + 响应回显。
// 缺省按版本 1 处理；不支持的值直接拒绝，避免旧客户端静默误用新语义。

import { codedError } from '../db/json.mjs';

export const PROTOCOL_VERSION_HEADER = 'x-sap-protocol-version';
export const CURRENT_PROTOCOL_VERSION = 1;
export const SUPPORTED_PROTOCOL_VERSIONS = [1];

/** 读取请求的协议版本；缺省返回当前版本。 */
export function requestedProtocolVersion(req) {
  const raw = req?.headers?.[PROTOCOL_VERSION_HEADER] ?? req?.headers?.['X-SAP-Protocol-Version'];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return CURRENT_PROTOCOL_VERSION;
  }
  const value = Number(String(raw).trim());
  return Number.isInteger(value) ? value : Number.NaN;
}

/** 校验协议版本；不支持时抛 400。 */
export function assertProtocolVersion(req) {
  const version = requestedProtocolVersion(req);
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    throw codedError(
      'UNSUPPORTED_PROTOCOL_VERSION',
      `不支持的协议版本：${req?.headers?.[PROTOCOL_VERSION_HEADER] ?? ''}；当前支持 ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`,
      400,
    );
  }
  return version;
}
