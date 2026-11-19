// 主体与在线状态的固定文案映射：在线状态与卡住任务类型。
export const PRESENCE_TEXT = { online: '在线', idle: '空闲', never: '从未活动' };
export const PRESENCE_TYPE = { online: 'success', idle: 'warning', never: 'info' };
export const STUCK_KIND_TEXT = {
  lease_expiring: '租约即将到期',
  review_overdue: '提交后长期未评审',
  heartbeat_stale: '心跳停滞',
};
