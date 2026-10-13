/**
 * 误操作包 · 专门模拟人真的会犯的错
 * 连点重复提交、填错数字/文字、查不存在的东西、重复操作、越界操作、伪造身份
 */
const { callRaw, db, num } = require('../lib')

module.exports = {
  id: 'mistakes',

  /** 领料员的误操作 */
  async pickerMistakes(agent, state) {
    const { A } = state

    // ① 网络卡了连点两下提交（同一个幂等键）→ 必须只有一张单
    const cri = `RA-DUP-R${state.round}-${state.RUN}`
    const s1 = await agent.call('outbound', 'submit', { type: 'lingyong', remark: `${state.mark}-连点`, items: [{ material_id: A.id, quantity: 1 }] }, cri)
    const s2 = await agent.call('outbound', 'submit', { type: 'lingyong', remark: `${state.mark}-连点`, items: [{ material_id: A.id, quantity: 1 }] }, cri)
    const dup1 = agent.mustOk('连点第一次提交', s1)
    const dup2 = agent.mustOk('连点第二次提交', s2)
    agent.check('连点返回「已提交过」', dup2.duplicated === true && Number(dup2._id) === Number(dup1._id), 'P0',
      `duplicated=${dup2.duplicated} id1=${dup1._id} id2=${dup2._id}`)
    const rows = await db.query('SELECT id FROM outbound_orders WHERE client_request_id = ?', [cri])
    agent.check('连点只落了一张单', rows.length === 1, 'P0', `实际 ${rows.length} 张`)
    // 清理：撤掉这张探针单
    await agent.call('outbound', 'cancel', { id: dup1._id, reason: '连点测试清理' })

    // ② 数量乱填
    for (const [qty, label] of [[0, '数量=0'], [-1, '数量=-1'], [1.5, '数量=1.5'], ['abc', '数量=文字']]) {
      const r = await agent.call('outbound', 'submit', { type: 'lingyong', items: [{ material_id: A.id, quantity: qty }] })
      agent.expectFail(`出库${label}被拒`, r, 'P1', 400)
    }

    // ③ 不存在的物料（服务端对「不存在」的明确表态是 404，也是拒绝）
    const noMat = await agent.call('outbound', 'submit', { type: 'lingyong', items: [{ material_id: 999999, quantity: 1 }] })
    agent.expectFail('出库不存在物料被拒', noMat, 'P1', 404)

    // ④ 空明细
    const empty = await agent.call('outbound', 'submit', { type: 'lingyong', items: [] })
    agent.expectFail('出库空明细被拒', empty, 'P1', 400)

    // ⑤ 领料员看不到库存：detail/list 里不应有库存字段（服务端脱敏）
    const det = await agent.call('material', 'detail', { id: A.id })
    const detData = det && det.data ? det.data : {}
    agent.check('领料员读物料无库存字段', detData.current_stock === undefined && detData.avg_cost === undefined, 'P0',
      `keys=${Object.keys(detData).filter(k => /stock|cost/.test(k)).join(',') || '(无)'}`)

    // ⑥ 超额领料：提交不拦（领料员看不到库存，缺货由仓管把关），但仓管确认时必须拦下
    const over = await agent.call('outbound', 'submit', { type: 'lingyong', items: [{ material_id: A.id, quantity: 99999 }], remark: '超额探针' })
    agent.mustOk('领料员超额提交不拦（由仓管把关）', over)
    const skAgents = require('../lib')
    const skToken = await skAgents.loginDev('dev_sk')
    const confirmRes = await skAgents.callRaw('outbound', 'confirm', { id: over.data._id }, skToken)
    agent.expectFail('仓管确认超额单被拒（库存不足）', confirmRes, 'P0', 400)
    // 清理这张探针单
    await agent.call('outbound', 'cancel', { id: over.data._id, reason: '超额探针' })

    // ⑦ 报废单规则：缺照片/缺备注都拒；齐全则放行
    const scrapNoPhoto = await agent.call('outbound', 'submit', {
      type: 'baofei', items: [{ material_id: A.id, quantity: 1 }], remark: '坏了'
    })
    agent.expectFail('报废缺照片被拒', scrapNoPhoto, 'P1', 400)
    const scrapNoRemark = await agent.call('outbound', 'submit', {
      type: 'baofei', items: [{ material_id: A.id, quantity: 1 }], attachment: '/uploads/scrap/test.png'
    })
    agent.expectFail('报废缺备注被拒', scrapNoRemark, 'P1', 400)
    const scrapOk = await agent.call('outbound', 'submit', {
      type: 'baofei', items: [{ material_id: A.id, quantity: 1 }],
      remark: `${state.mark || ''}报废探针`, attachment: '/uploads/scrap/test.png'
    })
    agent.mustOk('报废单（照片+备注齐全）提交成功', scrapOk)
    // 报废确认 = 当场扣库存办结（不走拣货/收货）
    const skLib = require('../lib')
    const skToken2 = await skLib.loginDev('dev_sk')
    const scrapConfirm = await skLib.callRaw('outbound', 'confirm', { id: scrapOk.data._id }, skToken2)
    agent.mustOk('报废单仓管确认', scrapConfirm)
    agent.check('报废确认后直接办结', scrapConfirm.data.status === 'completed', 'P0', String(scrapConfirm.data.status))
    const beforeVoid = await db.queryOne('SELECT current_stock FROM materials WHERE id = ?', [A.id])
    // 确认后不能再拣货（幂等提示也算过关，关键是不会重复扣）
    const pickAfter = await skLib.callRaw('outbound', 'pickDone', { id: scrapOk.data._id }, skToken2)
    agent.check('报废办结后拣货不重复扣', pickAfter.code !== 0 || (pickAfter.data && pickAfter.data.duplicated === true), 'P1',
      `code=${pickAfter.code} msg=${pickAfter.message}`)
    // 已完成单作废只有 admin 能干（会回补库存），使本探针净影响为 0
    const adminToken = await skLib.loginAdmin('admin', '123456')
    const voidRes = await skLib.callRaw('outbound', 'cancel', { id: scrapOk.data._id, reason: '探针作废回补' }, adminToken)
    agent.mustOk('报废单作废（回补库存）', voidRes)
    const afterVoid = await db.queryOne('SELECT current_stock FROM materials WHERE id = ?', [A.id])
    agent.check('作废后库存回补净影响为 0', num(afterVoid.current_stock) === num(beforeVoid.current_stock) + 1, 'P0',
      `扣后 ${beforeVoid.current_stock} → 回补后 ${afterVoid.current_stock}`)

    // ⑧ 重复收货（已经收过的单再收一次）→ 应提示「已收过」，不能扣两次
    if (state.orders.mainA) {
      const again = await agent.call('outbound', 'receive', { id: state.orders.mainA })
      agent.check('重复收货返回幂等提示', again && again.code === 0 && again.data && again.data.duplicated === true, 'P0',
        `code=${again && again.code} msg=${again && again.message}`)
    }
  },

  /** 仓管的误操作 */
  async storekeeperMistakes(agent, state) {
    const { A } = state

    // ① 重复拣货（已完成的单再拣）→ 幂等提示，不出错不重复扣
    if (state.orders.mainA) {
      const again = await agent.call('outbound', 'pickDone', { id: state.orders.mainA })
      agent.check('重复拣货返回幂等提示', again && again.code === 0 && again.data && again.data.duplicated === true, 'P1',
        `code=${again && again.code} msg=${again && again.message}`)
    }

    // ② 入库连点（同一幂等键提交两次）→ 只有一张单
    const cri = `RA-INDUP-R${state.round}-${state.RUN}`
    const i1 = await agent.call('inbound', 'submit', {
      type: 'purchase', supplier: `${state.mark}供应商`,
      items: [{ material_id: A.id, quantity: 1, unit_price: 1 }]
    }, cri)
    const i2 = await agent.call('inbound', 'submit', {
      type: 'purchase', supplier: `${state.mark}供应商`,
      items: [{ material_id: A.id, quantity: 1, unit_price: 1 }]
    }, cri)
    const d1 = agent.mustOk('入库连点第一次', i1)
    const d2 = agent.mustOk('入库连点第二次', i2)
    agent.check('入库连点只一张单', d2.duplicated === true, 'P0', `duplicated=${d2.duplicated}`)
    await agent.call('inbound', 'cancel', { id: d1._id, reason: '连点测试清理' })

    // ③ 改价填 0 → 必须被拒（成本会失真）
    const sub = await agent.call('inbound', 'submit', {
      type: 'purchase', supplier: `${state.mark}供应商`,
      items: [{ material_id: A.id, quantity: 1, unit_price: 5 }]
    })
    const inId = agent.mustOk('提交改价探针单', sub)._id
    const bad = await agent.call('inbound', 'updatePrice', { id: inId, items: [{ material_id: A.id, unit_price: 0 }] })
    agent.expectFail('改价填0被拒', bad, 'P1', 400)
    await agent.call('inbound', 'cancel', { id: inId, reason: '探针清理' })

    // ④ 盘点录入不存在的物料行 → 明确报错，不能静默吃掉
    const chk = await agent.call('check', 'create', {
      warehouse_id: A.wid, scope: { material_ids: [A.id] }, remark: `${state.mark}-误录`
    })
    const chkId = agent.mustOk('建误录盘点单', chk)._id
    const badLine = await agent.call('check', 'submit', {
      id: chkId, items: [{ material_id: 999999, actual_stock: 1 }]
    })
    agent.expectFail('盘点录不存在物料被拒', badLine, 'P1', 400)
    await agent.call('check', 'cancel', { id: chkId, reason: '误录测试清理' })

    // ⑤ 物料档案直改库存（这个口子必须封死）
    const hack = await agent.call('material', 'upsert', {
      _id: A.id, name: `${state.mark}测试物料A-${state.RUN}`, warehouse_id: A.wid, current_stock: 9999
    })
    agent.expectFail('档案直改库存被拒', hack, 'P0', 400)
  },

  /** 采购员的误操作 */
  async purchaseMistakes(agent, state) {
    const { B } = state

    // ① 重复领取（已领取的任务再领）→ 拒
    if (state.purchaseTask2Id) {
      // purchaseTask2 已走完全程（received），另建一张专门测重复领取
    }
    const created = await agent.call('purchase', 'list', { page: 1, pageSize: 50 })
    agent.check('采购任务列表可查', created && created.code === 0, 'P1')

    // 建一张新任务测重复领取（用仓管建，这里只负责领）
    return state // 实际领取动作由 run.js 编排（需要仓管配合），见 mistakes.takeTwice
  },

  /** 重复领取（需要仓管建好的任务）——同一人重复领是幂等提示（设计如此），不能报错也不能易主 */
  async takeTwice(agent, taskId) {
    const t1 = await agent.call('purchase', 'take', { id: taskId })
    agent.mustOk('第一次领取', t1)
    const t2 = await agent.call('purchase', 'take', { id: taskId })
    const msg = (t2 && t2.message) || ''
    agent.check(
      '重复领取返回幂等提示（仍是自己的任务）',
      t2 && t2.code === 0 && msg.includes('已经领取'),
      'P1', `code=${t2 && t2.code} msg=${msg}`
    )
  },

  /** 老板的误操作 */
  async bossMistakes(agent, state) {
    // 重复审批（已审完的盘点单再批一次）→ 拒
    if (state.checkId) {
      const again = await agent.call('check', 'review', { id: state.checkId, approve: true })
      agent.expectFail('重复审批被拒', again, 'P1', 400)
    }
  },

  /** 匿名/伪造身份（不用任何岗位 token） */
  async anonymousMistakes(results, round) {
    const push = (label, cond, level, detail) =>
      results.push({ round, role: '匿名', label, pass: !!cond, level: cond ? '' : level, detail: String(detail || '') })

    // ① 压根不带 token
    const noTok = await callRaw('user', 'list', { page: 1, pageSize: 1 })
    push('未登录访问被拒(401)', noTok && noTok.code === 401, 'P0', `code=${noTok && noTok.code}`)

    // ② 伪造 token
    const fake = await callRaw('user', 'list', { page: 1, pageSize: 1 }, 'abc.def.ghi')
    push('伪造token被拒(401)', fake && fake.code === 401, 'P0', `code=${fake && fake.code}`)

    // ③ 乱写模块名
    const noMod = await callRaw('nonexistent', 'list', {})
    push('不存在的模块被拒', !noMod || noMod.code !== 0, 'P1', `code=${noMod && noMod.code}`)
  }
}
