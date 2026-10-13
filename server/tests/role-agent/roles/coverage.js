/**
 * 功能补齐包 · 覆盖主流程之外的其余功能
 * 主数据（供应商/仓库/物料编辑）、用户全生命周期、改价、取消、驳回、退回重采、消息已读、统计报表
 */
const { loginAdmin, loginDev, num, db } = require('../lib')

module.exports = {
  id: 'coverage',

  /** 主数据：供应商增查、仓库增查、物料编辑、删除权限 */
  async masterData(agents, state) {
    const { purchaser, sk, boss, admin } = agents
    const { mark } = state

    // 供应商：采购员建档 → 搜索 → 详情 → 删除被拒（只有 boss/admin 能删）
    const sup = await purchaser.call('supplier', 'upsert', { name: `${mark}测试供应商-${state.RUN}` })
    const supId = purchaser.mustOk('采购员建供应商', sup)._id
    const search = await purchaser.call('supplier', 'search', { keyword: mark })
    const found = (purchaser.mustOk('搜索供应商', search).list || []).some((s) => Number(s._id) === Number(supId))
    purchaser.check('供应商能搜到', found, 'P1')
    const supDel = await purchaser.call('supplier', 'delete', { id: supId })
    purchaser.expectFail('采购员删供应商被拒', supDel, 'P0', 403)

    // 仓库：列表按数据权限收敛（V4 修：领料员只能看到自己的仓，仓管两个仓，老板全量）
    const wl = await sk.call('warehouse', 'list', {})
    const skList = sk.mustOk('仓库列表', wl).list || []
    sk.check('仓管看到且只看到自己的 2 个仓', skList.length === 2, 'P1',
      `实际 ${skList.length} 个：${skList.map((w) => w.name).join(',')}`)
    const wlPicker = await agents.picker.call('warehouse', 'list', {})
    const pickerList = agents.picker.mustOk('领料员仓库列表', wlPicker).list || []
    agents.picker.check('领料员只能看到配件仓 1 个', pickerList.length === 1, 'P0',
      `实际 ${pickerList.length} 个：${pickerList.map((w) => w.name).join(',')}`)

    // 管理员建测试仓 → 出现在列表 → 用完即软删（不留垃圾数据污染仓管页面）
    // 2026-10-09 老板只读后 warehouse.upsert 只放行 admin，建仓改由管理员执行
    const wup = await admin.call('warehouse', 'upsert', { name: `${mark}测试仓`, code: `RA${state.round}${state.RUN}`.slice(0, 20) })
    const newWid = admin.mustOk('管理员建测试仓', wup)._id
    const wl2 = await admin.call('warehouse', 'list', {})
    admin.check('新仓出现在管理员列表', (admin.mustOk('仓库列表2', wl2).list || []).some((w) => String(w.name).includes(mark)), 'P1')
    // 老板只读边界：建仓必须被拒
    const wupBoss = await boss.call('warehouse', 'upsert', { name: `${mark}老板越权仓`, code: 'RAXB' })
    boss.expectFail('老板建仓被拒（只读）', wupBoss, 'P0', 403)
    // 测试仓不该出现在仓管的列表里（数据权限）
    const wl3 = await sk.call('warehouse', 'list', {})
    sk.check('测试仓不出现在仓管列表', !(sk.mustOk('仓库列表3', wl3).list || []).some((w) => String(w.name).includes(mark)), 'P1')
    if (newWid) await db.execute('UPDATE warehouses SET is_deleted = 1 WHERE id = ?', [newWid])

    // 物料编辑（不能直改库存的口子已在误操作包里测）
    const edit = await sk.call('material', 'upsert', {
      _id: state.A.id, name: `${mark}测试物料A-${state.RUN}`, spec: `RA-A-${state.RUN}`,
      category: '测试类', unit: '箱', warehouse_id: state.A.wid, warning_stock: 5
    })
    sk.mustOk('编辑物料A单位', edit)
    const det = await sk.call('material', 'detail', { id: state.A.id })
    sk.check('编辑生效（单位=箱）', sk.mustOk('查物料A', det).unit === '箱', 'P1')

    const cats = await sk.call('material', 'categories', {})
    sk.check('物料分类接口可用', cats && cats.code === 0, 'P1')

    // 物料删除：仓管被拒（P0 探针）；管理员删一个专门建的垃圾物料（正常路径）
    const delDenied = await sk.call('material', 'delete', { id: state.A.id })
    sk.expectFail('仓管删物料被拒', delDenied, 'P0', 403)
    const junk = await admin.call('material', 'upsert', {
      name: `${mark}垃圾物料-${state.RUN}`, spec: `RA-JUNK-${state.RUN}`, category: '测试类',
      unit: '个', warehouse_id: 1, warning_stock: 0
    })
    const junkId = admin.mustOk('建垃圾物料', junk)._id
    const del = await admin.call('material', 'delete', { id: junkId })
    admin.mustOk('管理员删垃圾物料', del)
  },

  /** 用户全生命周期：建号→登录→改资料→重置密码→改密→禁用；待审用户审核通过 */
  async userLifecycle(agents, state, helpers) {
    const { admin } = agents
    const uname = `RA_user_R${state.round}_${state.RUN}`

    // 建普通账号（管理员走正常路径）
    const created = await admin.call('user', 'create', {
      username: uname, password: 'abc123456', real_name: `${state.mark}测试用户`,
      roles: ['out'], warehouse_ids: [1]
    })
    const uid = admin.mustOk('管理员建普通账号', created)._id

    // 新账号能登录后台（首次登录要改密）
    const token1 = await loginAdmin(uname, 'abc123456').catch(() => null)
    admin.check('新账号可登录后台', !!token1, 'P1')

    // 改资料留痕
    const upd = await admin.call('user', 'update', { id: uid, real_name: `${state.mark}测试用户2` })
    admin.mustOk('管理员改用户资料', upd)

    // 本人改密（先清门禁，否则只能改密别的干不了）
    if (token1) {
      const { callRaw } = require('../lib')
      const chg = await callRaw('auth', 'changePassword', { old_password: 'abc123456', new_password: 'abc123457' }, token1)
      admin.check('本人改密成功', chg && chg.code === 0, 'P1', `code=${chg && chg.code} ${chg && chg.message}`)
    }

    // 管理员重置密码 → 新密码能登录
    const rst = await admin.call('user', 'resetPassword', { id: uid, new_password: 'xyz123456' })
    admin.mustOk('管理员重置密码', rst)
    const token2 = await loginAdmin(uname, 'xyz123456').catch(() => null)
    admin.check('重置后新密码可登录', !!token2, 'P1')

    // 禁用 → 登录被拒
    const dis = await admin.call('user', 'disable', { id: uid })
    admin.mustOk('管理员禁用账号', dis)
    const denied = await loginAdmin(uname, 'xyz123456').catch((e) => e)
    admin.check('禁用后登录被拒', denied && denied.code === 403, 'P0', `code=${denied && denied.code}`)

    // 待审用户：全新 openid 自动建档 → 补姓名 → 管理员审核通过 → 登录有角色 → 清理
    const pendingOpenid = `dev_ra_pending_R${state.round}_${state.RUN}`
    const login = await admin.call('auth', 'login', { dev_openid: pendingOpenid })
    const pendUser = login && login.data ? login.data.user : null
    if (pendUser && pendUser.status === 'pending') {
      await admin.call('user', 'update', { id: pendUser._id, real_name: `${state.mark}待审用户` })
      const ap = await admin.call('user', 'approve', { id: pendUser._id, roles: ['out'], warehouse_ids: [1] })
      admin.mustOk('管理员审核通过待审用户', ap)
      const t3 = await loginDev(pendingOpenid)
      const { callRaw } = require('../lib')
      const info = await callRaw('auth', 'getUserInfo', {}, t3)
      const roles = info && info.data && Array.isArray(info.data.roles) ? info.data.roles : []
      admin.check('审核后登录拿到角色', roles.includes('out'), 'P1', JSON.stringify(roles))
      await admin.call('user', 'disable', { id: pendUser._id })
    } else {
      admin.check('构造待审用户', false, 'P1', `status=${pendUser && pendUser.status}`)
    }
  },

  /** 入库补充：改价（本人当天可改）+ 取消未确认单 */
  async inboundExtras(agents, state) {
    const { sk, boss, admin } = agents
    const { mark, A } = state

    const before = num((await sk.mustOk('改价前查A', await sk.call('material', 'detail', { id: A.id }))).current_stock)

    const sub = await sk.call('inbound', 'submit', {
      type: 'purchase', supplier: `${mark}供应商`, warehouse_id: A.wid, remark: `${mark}-改价取消`,
      items: [{ material_id: A.id, quantity: 2, unit_price: 8 }]
    })
    const inId = sk.mustOk('提交待改价入库单', sub)._id

    // 本人当天可改价
    const chg = await sk.call('inbound', 'updatePrice', { id: inId, items: [{ material_id: A.id, unit_price: 8.5 }] })
    sk.mustOk('本人改价', chg)

    // 管理角色不受「当天」限制
    // 2026-10-09：老板只读后改价归 管理员/仓管 → 改由管理员执行，并补一条老板越权断言
    const chg2 = await admin.call('inbound', 'updatePrice', { id: inId, items: [{ material_id: A.id, unit_price: 9 }] })
    admin.mustOk('管理员改价', chg2)
    const chgBoss = await boss.call('inbound', 'updatePrice', { id: inId, items: [{ material_id: A.id, unit_price: 9 }] })
    boss.expectFail('老板改价被拒（只读）', chgBoss, 'P0', 403)

    // 未确认可取消，库存不变
    const cxl = await sk.call('inbound', 'cancel', { id: inId, reason: '测错了' })
    sk.mustOk('取消未确认入库单', cxl)
    const after = num((await sk.mustOk('取消后查A', await sk.call('material', 'detail', { id: A.id }))).current_stock)
    sk.check('取消后库存未变', after === before, 'P0', `前 ${before} 后 ${after}`)
  },

  /** 出库补充：取消别人的单被拒、仓管驳回、计数接口 */
  async outboundExtras(agents, state) {
    const { sk, picker } = agents
    const { mark, A } = state

    // 仓管自己开的单，领料员不能撤（别人的单）
    const skOrder = await sk.call('outbound', 'submit', {
      type: 'lingyong', remark: `${mark}-sk单`, items: [{ material_id: A.id, quantity: 1 }]
    })
    const skOrderId = sk.mustOk('仓管提交出库单', skOrder)._id
    const cancelOther = await picker.call('outbound', 'cancel', { id: skOrderId, reason: '想撤别人的' })
    picker.expectFail('领料员撤别人的单被拒', cancelOther, 'P0', 403)
    const cancelSelf = await sk.call('outbound', 'cancel', { id: skOrderId, reason: '自己不测了' })
    sk.mustOk('仓管撤自己的单', cancelSelf)

    // 仓管驳回（角色里有驳回权）
    const r2 = await picker.call('outbound', 'submit', {
      type: 'lingyong', remark: `${mark}-sk驳回`, items: [{ material_id: A.id, quantity: 1 }]
    })
    const r2Id = picker.mustOk('提交被驳回单2', r2)._id
    const rej = await sk.call('outbound', 'reject', { id: r2Id, reason: '数量不对' })
    sk.mustOk('仓管驳回出库单', rej)

    // 计数接口（小程序待办红点用）
    for (const [agent, mod, action, label] of [
      [sk, 'outbound', 'pendingCount', '出库待确认数'],
      [sk, 'outbound', 'pickingCount', '出库待拣货数'],
      [sk, 'inbound', 'pendingCount', '入库待确认数'],
      [picker, 'outbound', 'myNotice', '领料员通知数'],
      [sk, 'purchase', 'myTodoCount', '采购待办数'],
      [sk, 'user', 'pendingCount', '待审用户数(仓管应被拒)']
    ]) {
      const res = await agent.call(mod, action, {})
      if (label.includes('应被拒')) agent.expectFail(label, res, 'P0', 403)
      else agent.check(`${label}可用`, res && res.code === 0, 'P1', `code=${res && res.code}`)
    }
  },

  /** 采购补充：退回重采全流程 + 取消任务 + 参与人列表 */
  async purchaseExtras(agents, state) {
    const { sk, purchaser } = agents
    const { mark, A, B } = state

    // 2026-10-12：采购任务只针对配件仓（成品不需要采购），退回重采改用配件仓物料 A
    const created = await sk.call('purchase', 'create', {
      warehouse_id: A.wid, assignee_openid: 'dev_purchase',
      remark: `${mark}退回重采测试`,
      items: [{ material_id: A.id, quantity: 1 }]
    })
    const tid = sk.mustOk('建退回测试任务', created)._id
    state.purchaseTask2Id = tid

    await purchaser.mustOk('领取任务2', await purchaser.call('purchase', 'take', { id: tid }))
    await purchaser.mustOk('录入任务2', await purchaser.call('purchase', 'entry', {
      id: tid, purchase_channel: '京东', remark: '第一次录入',
      items: [{ material_id: A.id, unit_price: 6 }]
    }))

    // 仓管发现价格不对 → 退回重采（状态回到「采购中」）
    const rb = await sk.call('purchase', 'rejectBack', { id: tid, reason: '单价偏高，重新比价' })
    sk.mustOk('退回重采', rb)

    // 退回后采购员重新录入（明细级渠道/单号）→ 仓管收料
    await purchaser.mustOk('退回后重新录入', await purchaser.call('purchase', 'entry', {
      id: tid, remark: '重谈后的价格',
      items: [{ material_id: A.id, unit_price: 6, purchase_channel: '线下', external_no: 'OFF-8899' }]
    }))
    const det2 = await purchaser.mustOk('查任务2详情', await purchaser.call('purchase', 'detail', { id: tid }))
    const item0 = (det2.items || [])[0] || {}
    purchaser.check('明细级购买方式已存（线下）', item0.purchase_channel === '线下', 'P1', String(item0.purchase_channel))
    purchaser.check('明细级外部单号已存', item0.external_no === 'OFF-8899', 'P1', String(item0.external_no))
    purchaser.check('任务级渠道自动汇总', det2.purchase_channel === '线下', 'P1', String(det2.purchase_channel))
    // V5.3：先逐项登记到齐，再完成入库
    await sk.mustOk('任务2逐项登记', await sk.call('purchase', 'receiveItem', {
      id: tid, item_id: item0._id, action: 'receive', received_qty: Number(item0.quantity)
    }))
    await sk.mustOk('任务2完成入库', await sk.call('purchase', 'receive', { id: tid }))

    // 误操作：整单和明细都不填购买方式 → 拒（改用配件仓物料 A，成品仓已不允许采购）
    const c5 = await sk.call('purchase', 'create', {
      warehouse_id: A.wid, remark: `${mark}缺渠道`, items: [{ material_id: A.id, quantity: 1 }]
    })
    const tid5 = sk.mustOk('建缺渠道任务', c5)._id
    await purchaser.mustOk('领取任务5', await purchaser.call('purchase', 'take', { id: tid5 }))
    const noCh = await purchaser.call('purchase', 'entry', {
      id: tid5, items: [{ material_id: A.id, unit_price: 6 }]
    })
    purchaser.expectFail('明细和整单都没渠道被拒', noCh, 'P1', 400)
    await sk.call('purchase', 'cancel', { id: tid5, reason: '探针清理' })

    // 取消一张用不着的任务（改用配件仓物料 A，成品仓已不允许采购）
    const c3 = await sk.call('purchase', 'create', {
      warehouse_id: A.wid, remark: `${mark}要取消的`, items: [{ material_id: A.id, quantity: 1 }]
    })
    const tid3 = sk.mustOk('建待取消任务', c3)._id
    const cx = await sk.call('purchase', 'cancel', { id: tid3, reason: '不需要了' })
    sk.mustOk('取消采购任务', cx)

    // 参与人列表
    const ass = await sk.call('purchase', 'assignees', {})
    sk.check('采购参与人列表可用', ass && ass.code === 0, 'P1')

    // —— V5.3 硬规则：采购单不允许整单一次入库，必须逐项登记 ——
    const c4 = await sk.call('purchase', 'create', {
      warehouse_id: A.wid, assignee_openid: 'dev_purchase',
      remark: `${mark}逐项规则测试`,
      items: [{ material_id: A.id, quantity: 1 }]
    })
    const tid4 = sk.mustOk('建逐项规则任务', c4)._id
    await purchaser.mustOk('领取任务4', await purchaser.call('purchase', 'take', { id: tid4 }))
    await purchaser.mustOk('录入任务4', await purchaser.call('purchase', 'entry', {
      id: tid4, purchase_channel: '线下', remark: '逐项规则',
      items: [{ material_id: A.id, unit_price: 7 }]
    }))

    // 未逐项登记直接收料 → 拒
    const direct = await sk.call('purchase', 'receive', { id: tid4 })
    sk.expectFail('未逐项登记直接入库被拒', direct, 'P0', 400)

    // 逐项登记到齐 → 收料成功，库存按实到入
    const d4 = await sk.call('purchase', 'detail', { id: tid4 })
    const it4 = (sk.mustOk('读任务4明细', d4).items || [])[0]
    await sk.mustOk('逐项登记到齐', await sk.call('purchase', 'receiveItem', {
      id: tid4, item_id: it4._id, action: 'receive', received_qty: 1
    }))
    const rcv = await sk.call('purchase', 'receive', { id: tid4 })
    const rcvData = sk.mustOk('逐项登记后完成入库', rcv)
    // 入库单明细只有 A×1（不再接受任何额外物料）
    const inbItems = await db.query(
      `SELECT material_id, quantity FROM inbound_order_items oi
        JOIN inbound_orders o ON o.id = oi.order_id WHERE o.order_no = ?`, [rcvData.inbound_order_no])
    sk.check('入库单只有任务物料×实到数', inbItems.length === 1
      && Number(inbItems[0].material_id) === A.id && Number(inbItems[0].quantity) === 1, 'P1',
      JSON.stringify(inbItems))
  },

  /** 盘点补充：建单后取消 */
  async checkExtras(agents, state) {
    const { sk } = agents
    const { mark, B } = state
    const created = await sk.call('check', 'create', {
      warehouse_id: B.wid, scope: { material_ids: [B.id] }, remark: `${mark}-取消测试`
    })
    const cid = sk.mustOk('建待取消盘点单', created)._id || sk.mustOk('x', created).id
    const cx = await sk.call('check', 'cancel', { id: cid, reason: '不盘了' })
    sk.mustOk('取消盘点单', cx)
  },

  /** 消息操作：未读数 → 单条已读 → 全部已读 */
  async messageOps(agents) {
    const { boss } = agents
    const unread1 = num(boss.mustOk('查未读数', await boss.call('message', 'unreadCount', {})).unread)
    const list = boss.mustOk('查消息列表', await boss.call('message', 'list', { page: 1, pageSize: 5 })).list || []
    if (list.length) {
      const mid = list[0]._id || list[0].id
      await boss.mustOk('单条已读', await boss.call('message', 'markRead', { id: mid }))
    }
    await boss.mustOk('全部已读', await boss.call('message', 'markAllRead', {}))
    const unread2 = num(boss.mustOk('再查未读数', await boss.call('message', 'unreadCount', {})).unread)
    boss.check('全部已读后未读=0', unread2 === 0, 'P1', `前 ${unread1} 后 ${unread2}`)
  },

  /** 统计报表：老板是「只读」——看数全放行，写/审动作全拒（2026-10-09 口径） */
  async statsReports(agents) {
    const { boss, admin, purchaser } = agents
    // 老板可看（只读看数）：排行 / 绩效 / 流水 / 台账 / 单据 / 预警
    for (const [action, data, label] of [
      ['materialRank', {}, '物料排行'],
      ['operatorStats', {}, '人员绩效'],
      ['stockFlow', { page: 1, pageSize: 5 }, '库存流水'],
      ['stockList', { page: 1, pageSize: 1 }, '库存台账'],
      ['orderFlow', { page: 1, pageSize: 1 }, '单据流水'],
      ['warning', { page: 1, pageSize: 1 }, '库存预警']
    ]) {
      const res = await boss.call('stats', action, data)
      boss.check(`老板可查${label}`, res && res.code === 0, 'P1', `code=${res && res.code}`)
    }
    // 唯一仍收回的看数接口：趋势分析只给管理员（小程序端也不给老板入口）
    const trBoss = await boss.call('stats', 'trend', {})
    boss.expectFail('老板查趋势分析被拒（小程序端本就无此入口）', trBoss, 'P1', 403)
    const tr = await admin.call('stats', 'trend', {})
    admin.check('管理员可查出入库趋势', tr && tr.code === 0, 'P1', `code=${tr && tr.code}`)
    const sf = await purchaser.call('stats', 'stockFlow', { page: 1, pageSize: 5 })
    purchaser.check('采购员可查库存流水（对账）', sf && sf.code === 0, 'P1', `code=${sf && sf.code}`)
  }
}
