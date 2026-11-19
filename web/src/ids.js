// 标识符展示规则：页面上只显示短标识，完整值通过复制取得。
// 前缀（item_ / task_ …）保留，哈希部分取前 7 位，与 git 短 SHA 的习惯一致。

const SHORT_HASH_LENGTH = 7;

/** 把 `item_ddc7474297c24e...` 缩成 `item_ddc7474`；无前缀的按短哈希处理。 */
export function shortId(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!text) return '';
  const separator = text.indexOf('_');
  if (separator > 0 && separator < text.length - 1) {
    const prefix = text.slice(0, separator);
    const hash = text.slice(separator + 1);
    return `${prefix}_${hash.slice(0, SHORT_HASH_LENGTH)}`;
  }
  return text.slice(0, SHORT_HASH_LENGTH);
}

/** 复制到剪贴板；失败时回退到旧的 execCommand 方案。 */
export async function copyText(text) {
  const value = String(text ?? '');
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // 忽略，走下面的回退。
  }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
