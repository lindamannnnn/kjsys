/**
 * 岗位 Agent · 领料员（dev_out，只有 wh1 权限）
 * 职责：提交领料单、撤销规则（待拣货可撤/待收货不可撤）、确认收货、越权探针
 */
const { db } = require('../lib')

module.exports = {
  id: 'picker',

  /** 提交本轮所有出库单 */
  async submitOrders(agent, state) {
    const { mark, A, B } = state
    const o = {}

    const mainA = await agent.call('outbound', 'submit', {
      type: 'lingyong', remark: mark,
      items: [{ material_id: A.id, quantity: 3 }]
    })
    o.mainA = agent.mustOk('提交主单A×3', mainA)._id

    const mainB = await agent.call('outbound', 'submit', {
      type: 'lingyong', remark: mark,
      items: [{ material_id: B.id, quantity: 2 }]
    })
    // B 在 wh2，领料员只有 wh1 权限 —— 这单应当被拒（数据权限）
    const mainBPass = mainB && mainB.code === 403
    agent.check('领料员跨仓提交wh2物料被拒', mainBPass, 'P1',
      mainBPass ? '' : `code=${mainB && mainB.code} ${mainB && mainB.message}`)
    o.mainB = null

    // 撤销规则探针单（都用 A，wh1）
    for (const key of ['cp', 'cpg', 'cr', 'rj']) {
      const r = await agent.call('outbound', 'submit', {
        type: 'lingyong', remark: `${mark}-${key}`,
        items: [{ material_id: A.id, quantity: 1 }]
      })
      o[key] = agent.mustOk(`提交探针单${key}`, r)._id
    }
    state.orders = o
  },

  /** 待确认(pending)：本人随时可撤销（不限时；10 分钟窗口规则已废除，2026-10-07 用户实测反馈） */
  async cancelPendingProbe(agent, state) {
    const res = await agent.call('outbound', 'cancel', { id: state.orders.cp, reason: '测错了' })
    agent.mustOk('待确认单本人可撤销', res)

    // 超过 10 分钟的老单也能撤：把 cp 单时间改到 2 小时前再撤一张同类的
    const sub = await agent.call('outbound', 'submit', {
      type: 'lingyong', remark: `${state.mark}-老单撤销`,
      items: [{ material_id: state.A.id, quantity: 1 }]
    })
    const oldId = agent.mustOk('提交老单探针', sub)._id
    await db.execute("UPDATE outbound_orders SET created_at = DATE_SUB(NOW(), INTERVAL 2 HOUR) WHERE id = ?", [oldId])
    const res2 = await agent.call('outbound', 'cancel', { id: oldId, reason: '回头撤单' })
    agent.mustOk('2小时前的待确认单本人仍可撤销', res2)
  },

  /** 待拣货(picking)：本人可撤销（用户定的规则） */
  async cancelPickingProbe(agent, state) {
    const res = await agent.call('outbound', 'cancel', { id: state.orders.cpg, reason: '不要了' })
    agent.mustOk('待拣货单本人可撤销', res)
  },

  /** 待收货(receiving)：本人不可撤销（用户定的规则），必须走收货完成 */
  async cancelReceivingProbe(agent, state) {
    const id = state.orders.cr
    const res = await agent.call('outbound', 'cancel', { id, reason: '试试' })
    agent.expectFail('待收货单本人撤销被拒', res, 'P1', 403)
    // 走正常收货把它闭环
    const recv = await agent.call('outbound', 'receive', { id })
    agent.mustOk('待收货单确认收货', recv)
  },

  /** 主单收货 */
  async receiveMain(agent, state) {
    const res = await agent.call('outbound', 'receive', { id: state.orders.mainA })
    agent.mustOk('主单A确认收货', res)
  },

  /** 消息：拣货完成后领料员应收到「来收货」通知（同事务投递） */
  async messageCheck(agent, state) {
    const res = await agent.call('message', 'list', { page: 1, pageSize: 50 })
    const list = (agent.mustOk('领料员查消息', res).list) || []
    const hit = list.find((m) => m.type === 'outbound_picked' && Number(m.ref_id) === Number(state.orders.mainA))
    agent.check('领料员收到拣货完成通知', !!hit, 'P1', hit ? '' : '消息列表里没有 outbound_picked')
  },

  /** 越权探针 */
  async negativeProbes(agent) {
    const p1 = await agent.call('inbound', 'submit', {
      type: 'purchase', supplier: 'x', items: [{ material_id: 1, quantity: 1, unit_price: 1 }]
    })
    agent.expectFail('领料员提交入库被拒', p1, 'P0', 403)

    const p2 = await agent.call('purchase', 'create', { items: [{ material_id: 1, quantity: 1 }] })
    agent.expectFail('领料员建采购任务被拒', p2, 'P0', 403)

    const p3 = await agent.call('user', 'list', { page: 1, pageSize: 1 })
    agent.expectFail('领料员访问用户列表被拒', p3, 'P0', 403)

    const p4 = await agent.call('check', 'create', { warehouse_id: 1, scope: { material_ids: [1] } })
    agent.expectFail('领料员建盘点单被拒', p4, 'P0', 403)
  }
}
