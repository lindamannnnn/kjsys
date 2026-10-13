/**
 * 岗位 Agent · 仓管员（dev_sk，管配件仓+成品仓）
 * 职责：入库、出库确认/拣货、采购建单与收料、盘点发起与录入
 */
module.exports = {
  id: 'storekeeper',

  /** 建测试物料 + 直接入库铺路（含单价 0 / 负数回归探针） */
  async inboundSetup(agent, state) {
    const { mark, A, B } = state

    // —— 物料建档（每轮两个新物料，与真实数据隔离；带 RUN 防跨批重名） ——
    const mkA = await agent.call('material', 'upsert', {
      name: `${mark}测试物料A-${state.RUN}`, spec: `RA-A-${state.RUN}`, category: '测试类', unit: '个',
      warehouse_id: A.wid, warning_stock: 3, remark: mark
    })
    A.id = agent.mustOk('建仓物料A', mkA)._id

    const mkB = await agent.call('material', 'upsert', {
      name: `${mark}测试物料B-${state.RUN}`, spec: `RA-B-${state.RUN}`, category: '测试类', unit: '个',
      warehouse_id: B.wid, warning_stock: 3, remark: mark
    })
    B.id = agent.mustOk('建仓物料B', mkB)._id

    // —— 回归：单价 0 / 负数 / 文字必须被拒（V3 P1-1） ——
    const p0 = await agent.call('inbound', 'submit', {
      type: 'purchase', supplier: `${mark}供应商`,
      items: [{ material_id: A.id, quantity: 1, unit_price: 0 }]
    })
    agent.expectFail('入库单价=0 被拒', p0, 'P1', 400)

    const pNeg = await agent.call('inbound', 'submit', {
      type: 'purchase', supplier: `${mark}供应商`,
      items: [{ material_id: A.id, quantity: 1, unit_price: -3 }]
    })
    agent.expectFail('入库单价<0 被拒', pNeg, 'P1', 400)

    // —— 正常入库：A 进 wh1、B 进 wh2 ——
    for (const M of [A, B]) {
      const sub = await agent.call('inbound', 'submit', {
        type: 'purchase', supplier: `${mark}供应商`, warehouse_id: M.wid,
        remark: mark,
        items: [{ material_id: M.id, quantity: M.init, unit_price: M.price }]
      })
      const inData = agent.mustOk(`入库提交(${M.id})`, sub)
      const conf = await agent.call('inbound', 'confirm', { id: inData._id })
      agent.mustOk(`入库确认(${M.id})`, conf)
    }
  },

  /** 出库：确认（pending→picking） */
  async confirmOrder(agent, id, label) {
    const res = await agent.call('outbound', 'confirm', { id })
    agent.mustOk(label, res)
  },

  /** 出库：拣货完成（picking→receiving） */
  async pickDone(agent, id, label) {
    const res = await agent.call('outbound', 'pickDone', { id })
    agent.mustOk(label, res)
  },

  /** wh2 物料 B 的完整出库闭环（仓管有双仓权限，领料员没有，所以由仓管走） */
  async outboundFullLoopB(agent, state) {
    const { mark, B } = state
    const sub = await agent.call('outbound', 'submit', {
      type: 'lingyong', remark: `${mark}-B`,
      items: [{ material_id: B.id, quantity: 2 }]
    })
    const id = agent.mustOk('仓管提交B单×2', sub)._id
    state.orders.mainB = id
    await this.confirmOrder(agent, id, '仓管确认B单')
    await this.pickDone(agent, id, '仓管拣货B单')
    const recv = await agent.call('outbound', 'receive', { id })
    agent.mustOk('仓管收货B单', recv)
  },

  /** 建采购任务（指派给 dev_purchase，含建单备注） */
  async createPurchaseTask(agent, state) {
    const { mark, A } = state
    const res = await agent.call('purchase', 'create', {
      warehouse_id: A.wid, assignee_openid: 'dev_purchase',
      remark: `${mark}建单备注：库存快没了`,
      items: [{ material_id: A.id, quantity: 5 }]
    })
    state.purchaseTaskId = agent.mustOk('建采购任务', res)._id
  },

  /** 采购收料：先逐项登记到齐（V5.3 起不允许整单一次入库），再完成入库 */
  async receivePurchase(agent, state) {
    const d = await agent.call('purchase', 'detail', { id: state.purchaseTaskId })
    const items = agent.mustOk('读采购明细', d).items || []
    for (const it of items) {
      agent.mustOk(`逐项登记到齐(${it.material_name})`, await agent.call('purchase', 'receiveItem', {
        id: state.purchaseTaskId, item_id: it._id, action: 'receive', received_qty: Number(it.quantity)
      }))
    }
    const res = await agent.call('purchase', 'receive', { id: state.purchaseTaskId })
    agent.mustOk('采购完成入库', res)
  },

  /** 盘点：建单（只含物料A）→ 录入（实盘=账面-2）→ 提交；再改一次应被拒 */
  async createAndSubmitCheck(agent, state) {
    const { mark, A } = state
    const created = await agent.call('check', 'create', {
      warehouse_id: A.wid, scope: { material_ids: [A.id] }, remark: mark
    })
    const chk = agent.mustOk('建盘点单', created)
    state.checkId = chk._id || chk.id

    const det = await agent.call('material', 'detail', { id: A.id })
    const book = Number(agent.mustOk('查物料A账面', det).current_stock)
    state.checkBookA = book

    const sub = await agent.call('check', 'submit', {
      id: state.checkId,
      items: [{ material_id: A.id, actual_stock: book - 2, remark: '实盘少2个' }]
    })
    agent.mustOk('盘点录入提交', sub)

    // 回归：已提交待审的单不允许再改数（P1-5）
    const again = await agent.call('check', 'submit', {
      id: state.checkId,
      items: [{ material_id: A.id, actual_stock: book - 1 }]
    })
    agent.expectFail('待审盘点单二次改数被拒', again, 'P1', 400)
  },

  /** 越权探针（每个都应 403 且被记入 permission_denied 日志） */
  async negativeProbes(agent) {
    const p1 = await agent.call('user', 'list', { page: 1, pageSize: 1 })
    agent.expectFail('仓管访问用户列表被拒', p1, 'P0', 403)

    const p2 = await agent.call('user', 'updateRole', { id: 99999, roles: ['out'] })
    agent.expectFail('仓管改角色被拒', p2, 'P0', 403)

    const p3 = await agent.call('warehouse', 'upsert', { name: '越权仓', code: 'RA-HACK' })
    agent.expectFail('仓管建仓库被拒', p3, 'P0', 403)
  }
}
