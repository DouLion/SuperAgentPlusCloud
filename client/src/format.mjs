// 客户端输出格式化（T7 归置）。
// 集中各命令重复的「打印列表/详情/错误」逻辑，命令文件只负责调用。

/** 打印一行「标签：值」；值为空时跳过。 */
export function line(out, label, value) {
  if (value === undefined || value === null || value === '') return;
  out(`  ${label}：${value}`);
}

/** 把 commit 引用（字符串或对象）格式化为可读文本。 */
export function formatCommitRef(ref) {
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object') {
    const repo = ref.repo ?? '';
    const hash = ref.hash ?? '';
    const branch = ref.branch ? `（分支 ${ref.branch}）` : '';
    return hash ? `${repo}${branch}@${hash}` : `${repo}${branch}`;
  }
  return String(ref);
}

/** 关系项可能是字符串或对象，统一格式化为可读文本。 */
export function formatRelation(relation) {
  if (typeof relation === 'string') return relation;
  if (relation && typeof relation === 'object') {
    const type = relation.type ? `${relation.type} ` : '';
    const itemId = relation.item_id ?? relation.itemId ?? '';
    return `${type}${itemId}`.trim();
  }
  return String(relation);
}

/** 打印需求时间线。 */
export function printTimeline(out, events) {
  out('时间线：');
  if (events.length === 0) {
    out('  （无）');
    return;
  }
  for (const event of events) {
    const actor = event.actor ? ` by ${event.actor}` : '';
    const reason = event.reason ? `　理由：${event.reason}` : '';
    out(`  ${event.occurred_at}　${event.event_type}${actor}${reason}`);
  }
}

/** 把错误信息写到 stderr；非 Error 对象转为字符串。 */
export function printError(err, errOut) {
  errOut(err instanceof Error ? err.message : String(err));
}
