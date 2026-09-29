/**
 * ============================================================
 * 业务字典 → 中文文案
 * ------------------------------------------------------------
 * 背景（来自 4 角色使用者测试 P2）：
 *   高中学历的仓管看到「当前状态：confirmed」完全看不懂，
 *   所有对外提示语一律输出中文，英文字段名只留在数据库里。
 * ============================================================
 */

/** 单据 / 盘点状态 */
const STATUS_TEXT = {
  pending: '待确认',
  pending_review: '待审核',
  in_progress: '盘点中',
  confirmed: '已确认',
  completed: '已完成',
  cancelled: '已作废',
  rejected: '已驳回'
}

/** 出库类型 */
const OUTBOUND_TYPE_TEXT = {
  lingyong: '领用',
  repair: '维修',
  sale: '销售',
  scrap: '报废',
  gift: '赠品',
  adjust: '调整',
  purchase: '采购退货',
  transfer: '调拨'
}

/** 入库类型 */
const INBOUND_TYPE_TEXT = {
  purchase: '采购入库',
  repair: '维修入库',
  return: '退货入库',
  transfer: '调拨入库',
  adjust: '调整',
  other: '其他'
}

/** 库存变动类型 */
const CHANGE_TYPE_TEXT = {
  inbound: '入库',
  outbound: '出库',
  outbound_cancel: '出库撤销回补',
  inbound_cancel: '入库撤销回退',
  check_adjust: '盘点差异调整',
  price_adjust: '改价成本修正',
  init: '期初建账'
}

/** 状态 → 中文（未知值原样返回，避免界面空白） */
function statusText(status) {
  return STATUS_TEXT[status] || String(status || '')
}

/** 单据类型 → 中文 */
function typeText(kind, type) {
  const t = String(type || '')
  if (kind === 'inbound') return INBOUND_TYPE_TEXT[t] || t
  return OUTBOUND_TYPE_TEXT[t] || t
}

/** 库存变动类型 → 中文 */
function changeTypeText(changeType) {
  return CHANGE_TYPE_TEXT[changeType] || String(changeType || '')
}

module.exports = {
  STATUS_TEXT,
  OUTBOUND_TYPE_TEXT,
  INBOUND_TYPE_TEXT,
  CHANGE_TYPE_TEXT,
  statusText,
  typeText,
  changeTypeText
}
