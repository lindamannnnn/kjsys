/**
 * ============================================================
 * 库存预警口径（全系统唯一出处）
 * ------------------------------------------------------------
 * 为什么必须只有一处：
 *   这个条件原先散落在 6 个地方（看板、预警明细、物料列表、仓库汇总、
 *   定时任务…），每处写法还不一样（`<=` 与 `<` 混用、有没有排除档案料不一），
 *   于是必然越走越远 —— 已经真实发生过「看板显示预警 1906，点进去没几条」。
 *
 * 口径定义（两个条件缺一不可）：
 *   1. 必须**低于**阈值才算缺货（等于阈值不算）
 *   2. 必须`warning_stock > 0`——没设预警线的物料不参与预警
 *   3. 默认排除「从未发生过出入库的纯档案料」：刚建档还没进过货的料动辄上千条，
 *      全算成预警会把真正的缺货淹没
 *
 * 用法：SQL 里物料的别名必须是 `m`
 *   WHERE ${WARNING_COND}
 *
 * 需要「连档案料一起看」的场景（如预警页显式传 includeIdle=true），
 * 用 WARNING_COND_INCLUDE_IDLE。
 * ============================================================
 */

/** 默认口径：低于阈值 + 排除从未出入库的档案料 */
const WARNING_COND = `(m.warning_stock > 0 AND m.current_stock < m.warning_stock
            AND EXISTS (SELECT 1 FROM stock_logs l WHERE l.material_id = m.id))`

/** 放开档案料的口径（仅用于「我要看全部低库存」的显式场景） */
const WARNING_COND_INCLUDE_IDLE = `(m.warning_stock > 0 AND m.current_stock < m.warning_stock)`

module.exports = {
  WARNING_COND,
  WARNING_COND_INCLUDE_IDLE
}
