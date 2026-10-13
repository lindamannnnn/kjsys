/**
 * 岗位 Agent · 厂长（dev_director）
 * ============================================================
 * 职责（2026-10-06 用户原话）：发采购单、盘点、审核盘点、看两个仓库的库存（含金额）。
 * 本用例进「每轮主流程」（run.js 的 rounds），做成**自包含工位**：
 *   - 不碰共享的 A/B 物料（盘点、采购都用厂长自己建的料），不干扰其它岗位的对账
 *   - 建完即取消（盘点建→提交→取消），不留状态尾巴
 *   - 采购任务建完不取消（purchase.cancel 没给厂长，是设计），由收尾清理脚本删
 *     （creator_openid LIKE 'dev_%' 会被 cleanup-test-data.js 收走）
 *
 * 厂长的「审核盘点」正例不在本工位做（本工位的盘点都被厂长自己取消了），
 *   它由独立的 director-check.js 覆盖（42 项，含厂长审别人建的盘点单）。
 *   本工位只验证「能点开别人建的盘点单 = 审核入口可达」。
 * ============================================================
 */
module.exports = {
  id: 'director',

  /** 厂长本轮自主工位：建档 + 看两仓 + 盘点全流程 + 发采购单 + 能开别人的盘点单 */
  async station(agents, state) {
    const agent = agents.director
    const mark = state.mark

    // —— 1. 自己建一个测试物料（厂长有 material.upsert，带标记供清理识别） ——
    const up = await agent.call('material', 'upsert', {
      name: `${mark}厂长自测料`,
      spec: 'DIR-1',
      category: '配件',
      unit: '个',
      warning_stock: 0,
      warehouse_id: 1
    })
    const mat = agent.mustOk('厂长建档物料（material.upsert）', up, 'P1')
    const mid = Number(mat._id)
    state.directorMatId = mid // 登记，避免对账把它当成共享料

    // —— 2. 看两个仓库的库存（含金额：avg_cost 不能被脱敏掉） ——
    const s1 = await agent.call('stats', 'stockList', { page: 1, pageSize: 1, warehouse_id: 1 })
    agent.check('厂长能看配件仓库存', s1.code === 0, 'P1', `code=${s1.code}`)
    const s2 = await agent.call('stats', 'stockList', { page: 1, pageSize: 1, warehouse_id: 2 })
    agent.check('厂长能看成品仓库存', s2.code === 0, 'P1', `code=${s2.code}`)
    const row = (s1.data && s1.data.list || [])[0] || {}
    agent.check('厂长能看库存金额（avg_cost 未脱敏）', row.avg_cost !== undefined, 'P1',
      `字段=${Object.keys(row).join(',')}`)
    const ws = await agent.call('stats', 'warehouseSummary', {})
    agent.check('厂长能看两仓总值（含金额）', ws.code === 0 && (ws.data.list || []).length === 2, 'P1',
      `code=${ws.code} 仓数=${(ws.data.list || []).length}`)

    // —— 3. 盘点全流程：建单 → 提交 → 取消（自己建的，实盘=账面不动库存） ——
    const ck = await agent.call('check', 'create', {
      warehouse_id: 1,
      type: 'sample',
      remark: `${mark}厂长盘点`,
      scope: { material_ids: [mid] }
    })
    const checkId = agent.mustOk('厂长建盘点单', ck, 'P1')._id
    if (checkId) {
      const detail = await agent.call('check', 'detail', { id: checkId })
      const item = (agent.mustOk('厂长看自己的盘点明细', detail).items || [])[0]
      const sub = await agent.call('check', 'submit', {
        id: checkId,
        items: [{ material_id: item.material_id, actual_stock: Number(item.book_stock || 0) }]
      })
      agent.mustOk('厂长提交盘点结果', sub, 'P1')
      const cc = await agent.call('check', 'cancel', { id: checkId, reason: `${mark}厂长自测取消` })
      agent.mustOk('厂长取消自己的盘点单', cc, 'P1')
    }

    // —— 4. 发采购单（厂长有 purchase.create；cancel 不给厂长是设计，留给清理脚本） ——
    const pt = await agent.call('purchase', 'create', {
      warehouse_id: 1,
      remark: `${mark}厂长发采购单`,
      items: [{ material_id: mid, quantity: 3 }]
    })
    agent.mustOk('厂长发采购单（purchase.create）', pt, 'P1')

    // —— 5. 能点开「别人建的」盘点单（审核入口可达；这正是 assertCheckVisible 放行 director 的意义） ——
    if (state.checkId) {
      const dv = await agent.call('check', 'detail', { id: state.checkId })
      agent.check('厂长能点开仓管建的盘点单（审核入口可达）', dv.code === 0, 'P0',
        `code=${dv.code} ${dv.message || ''}`)
    }
  },

  /** 厂长误操作 / 越权探针：他不该能做的全部要被拒，库存不能动 */
  async probes(agents, state) {
    const agent = agents.director
    const mid = state.directorMatId

    // 入库是仓管的活
    const inRes = await agent.call('inbound', 'submit', {
      warehouse_id: 1, supplier: 'x', items: [{ material_id: mid, quantity: 1, unit_price: 1 }]
    })
    agent.expectFail('厂长提交入库被拒', inRes, 'P0', 403)

    // 驳回出库是仓管/管理员的活
    const rj = await agent.call('outbound', 'reject', { id: state.orders.mainA || 1, reason: '越权探针' })
    agent.expectFail('厂长驳回出库被拒', rj, 'P0', 403)

    // 删物料是管理员的活
    const md = await agent.call('material', 'delete', { id: mid })
    agent.expectFail('厂长删物料被拒', md, 'P0', 403)

    // 建用户是管理员的活
    const uc = await agent.call('user', 'create', { username: `dirp_${state.RUN}`, real_name: 'x', password: 'x' })
    agent.expectFail('厂长建用户被拒', uc, 'P0', 403)

    // 趋势分析只给管理员
    const tr = await agent.call('stats', 'trend', {})
    agent.expectFail('厂长查趋势分析被拒', tr, 'P1', 403)

    // 乱填：盘点建单不带仓库 → 应 400（参数错），不是 403（权限对）也不是 500（崩）
    const badCk = await agent.call('check', 'create', { remark: `${state.mark}不带仓库` })
    agent.expectFail('盘点建单不带仓库被参数校验拦下', badCk, 'P1', 400)

    // 乱填：发采购单不带明细 → 应 400
    const badPt = await agent.call('purchase', 'create', { warehouse_id: 1, remark: `${state.mark}空明细` })
    agent.expectFail('采购建单不带明细被参数校验拦下', badPt, 'P1', 400)
  }
}
