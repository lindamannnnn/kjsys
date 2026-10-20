/**
 * ============================================================
 * 入参校验工具
 * ------------------------------------------------------------
 * 背景（来自 4 角色使用者测试）：
 *   原实现只判 `quantity <= 0`，导致「0.5 个火花塞」「-3 个空气滤芯」
 *   这类仓库里根本不存在的数量能直接落库，库存永远对不平。
 *
 * 规则：
 *   - 数量（库存单位）默认必须是「正整数」
 *   - 单价、金额允许两位小数
 *   - 报错提示必须是仓库管理员看得懂的普通话，不带英文字段名
 * ============================================================
 */
const { errors } = require('./response')

/** 取数字，非法返回 NaN（不复用 num 的兜底值，避免把"填错"当"填 0"） */
function toNumberStrict(value) {
  if (value === null || value === undefined || value === '') return NaN
  const n = Number(value)
  return Number.isFinite(n) ? n : NaN
}

/**
 * 库存数量校验：必须是正整数（>= 1）
 * @param {*} value 前端传入值
 * @param {string} label 业务名称，用于拼错误提示，如「出库数量」
 * @returns {number} 校验通过的数量
 */
function positiveInt(value, label = '数量') {
  const n = toNumberStrict(value)
  if (!Number.isFinite(n)) {
    throw errors.badRequest(`${label}必须是数字（当前填入：${value === '' ? '空' : value}）`)
  }
  if (n <= 0) {
    throw errors.badRequest(`${label}必须大于 0（当前填入：${n}）`)
  }
  if (!Number.isInteger(n)) {
    throw errors.badRequest(
      `${label}必须是整数，不能带小数（当前填入：${n}）。` +
      `库存单位是「个/件」，不允许半个。如确实需要小数请先调整物料单位`
    )
  }
  return n
}

/**
 * 盘点实盘数校验：必须是「非负整数」（可以是 0，代表实物已经没了）
 * 负数一律拒绝 —— 仓库里不存在负数个实物
 */
function nonNegativeInt(value, label = '实盘数量') {
  const n = toNumberStrict(value)
  if (!Number.isFinite(n)) {
    throw errors.badRequest(`${label}必须是数字（当前填入：${value === '' ? '空' : value}）`)
  }
  if (n < 0) {
    throw errors.badRequest(
      `${label}不能是负数（当前填入：${n}）。` +
      `如果实物已经没有了，请填 0；如果是盘亏，系统会自动算出负数差异`
    )
  }
  if (!Number.isInteger(n)) {
    throw errors.badRequest(`${label}必须是整数，不能带小数（当前填入：${n}）`)
  }
  return n
}

/**
 * 单价校验：必须大于 0，最多两位小数
 *
 * ⚠️ 整改（V3 测试 P1-1）：原实现只要求「非负」，于是入库单价可以填 0，
 *   这批货的入库成本就变成 0，加权平均成本被拉低、库存价值与毛利全失真。
 *   而采购录入那边（purchase.entry）一直是「必须 > 0」的，两边口径必须一致。
 *   真的不收钱的（赠品/样品）应走「其他」并把实际成本记 0 的场景另行设计，
 *   不能在入库单上随手填 0。
 */
function unitPrice(value, label = '单价') {
  const n = toNumberStrict(value)
  if (!Number.isFinite(n)) {
    throw errors.badRequest(`${label}必须是数字（当前填入：${value === '' ? '空' : value}）`)
  }
  if (n === 0) {
    throw errors.badRequest(
      `${label}必须大于 0（当前填入：0）。` +
      `填 0 会让这批货的入库成本变成 0，库存金额和成本核算都会失真；` +
      `赠品/样品请填一个实际成本价`
    )
  }
  if (n < 0) {
    throw errors.badRequest(`${label}不能是负数（当前填入：${n}）`)
  }
  return Number(n.toFixed(2))
}

/**
 * 单价校验（允许留空）：空 → null，表示「待补价」
 *
 * ⚠️ 为什么不能直接当成 0（2026-10-20）：
 *   销售端未接入时成品仓没有价格数据，员工填不出单价。若按 0 入库，
 *   移动加权成本会被 0 永久稀释（改不回来），所以这里返回 **null** 而不是 0，
 *   由 stock.addForInbound 识别为「不参与加权」，成本保持原值。
 *   空值究竟允不允许，由调用方按仓库决定（配件仓仍必须填价）。
 */
function unitPriceOrNull(value, label = '单价') {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  return unitPrice(value, label)
}

/** 预警库存校验：非负整数 */
function warningStock(value, label = '预警库存') {
  const n = toNumberStrict(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Number(n.toFixed(0))
}

module.exports = {
  toNumberStrict,
  positiveInt,
  nonNegativeInt,
  unitPrice,
  unitPriceOrNull,
  warningStock
}
