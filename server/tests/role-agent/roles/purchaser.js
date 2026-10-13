/**
 * 岗位 Agent · 采购员（dev_purchase，跨仓 [1,2]）
 * 职责：领取采购任务、录入采购信息（单价>0、备注追加）、越权探针
 */
module.exports = {
  id: 'purchaser',

  /** 领取任务 → 坏单价被拒 → 正确录入 → 验证备注是追加不是覆盖 */
  async takeAndEntry(agent, state) {
    const { mark, A } = state
    const taskId = state.purchaseTaskId

    const take = await agent.call('purchase', 'take', { id: taskId })
    agent.mustOk('领取采购任务', take)

    // 回归：单价 0 必须被拒（采购成本按它算）
    const bad = await agent.call('purchase', 'entry', {
      id: taskId, purchase_channel: '淘宝',
      items: [{ material_id: A.id, unit_price: 0 }]
    })
    agent.expectFail('采购录入单价=0 被拒', bad, 'P1', 400)

    const good = await agent.call('purchase', 'entry', {
      id: taskId, purchase_channel: '淘宝', external_no: `${mark}-TB001`,
      remark: '采购备注：已在淘宝下单',
      items: [{ material_id: A.id, unit_price: 12.5 }]
    })
    agent.mustOk('采购录入', good)

    // 回归：建单备注不能被覆盖（V3 P1-5）
    const det = await agent.call('purchase', 'detail', { id: taskId })
    const remark = String(agent.mustOk('查采购任务详情', det).remark || '')
    agent.check(
      '建单备注与采购备注都在（追加而非覆盖）',
      remark.includes('建单备注') && remark.includes('采购备注'),
      'P1', remark ? '' : '备注为空'
    )
  },

  /** 越权探针 + 采购员应有的只读权限（回归 P1-12） */
  async negativeProbes(agent) {
    const p1 = await agent.call('inbound', 'submit', {
      type: 'purchase', supplier: 'x', items: [{ material_id: 1, quantity: 1, unit_price: 1 }]
    })
    agent.expectFail('采购员直接入库被拒', p1, 'P0', 403)

    const p2 = await agent.call('check', 'review', { id: 1, approve: true })
    agent.expectFail('采购员审批盘点被拒', p2, 'P0', 403)

    const p3 = await agent.call('material', 'import', { items: [] })
    agent.expectFail('采购员导入物料被拒', p3, 'P0', 403)

    // 采购员月底对账要看出库流水（整改 P1-12 放开的只读权限，不能又被收回去）
    const flow = await agent.call('stats', 'orderFlow', { page: 1, pageSize: 5 })
    agent.check('采购员可查出库流水（P1-12）', flow && flow.code === 0, 'P1',
      `code=${flow && flow.code} ${flow && flow.message}`)
  }
}
