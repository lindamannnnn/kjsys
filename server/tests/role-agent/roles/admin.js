/**
 * 岗位 Agent · 后台管理员（admin，Web 后台）
 * 职责：后台登录、看板/预警口径一致性、唯一管理员保护探针
 */
const { db } = require('../lib')

module.exports = {
  id: 'admin',

  /** 后台登录 + 抓管理员视角看板 */
  async loginAndSnapshot(agent, state) {
    const ov = await agent.call('stats', 'overview', {})
    state.overviews.admin = agent.mustOk('管理员看板', ov)
  },

  /**
   * 盘点审核（正例）：2026-10-09 老板只读后，审核权归 厂长 + 管理员。
   * 这里把原来挂在老板身上的「非法值全拒 → 明确通过 → 库存确实被调整」
   * 整条链路搬到管理员，确保审核能力没有因为这次权限调整而丢。
   */
  async reviewCheck(agent, state) {
    const id = state.checkId

    const badValues = ['yes', 2, undefined]
    for (const v of badValues) {
      const data = v === undefined ? { id } : { id, approve: v }
      const res = await agent.call('check', 'review', data)
      agent.expectFail(`管理员审批传 ${JSON.stringify(v)} 被拒`, res, 'P1', 400)
    }

    const okRes = await agent.call('check', 'review', { id, approve: true, remark: '同意' })
    agent.mustOk('管理员盘点审批通过', okRes)

    // 库存必须被调整为实盘数（账面-2）
    const det = await agent.call('material', 'detail', { id: state.A.id })
    const now = Number(agent.mustOk('审批后查物料A', det).current_stock)
    agent.check('审批后库存=实盘数', now === state.checkBookA - 2, 'P0',
      `账面 ${state.checkBookA}，实盘应为 ${state.checkBookA - 2}，实际 ${now}`)
  },

  /**
   * 消息（正例）：盘点提交后的「待审核」提醒必须投递到**审核人**。
   * ⚠️ 判据不能用「管理员的收件箱」：后台管理员是账号密码登录、openid 为空，
   *    按 openid 投递的站内信本来就到不了他（他能从后台「盘点管理」看到待办）。
   *    所以这里直接查库，断言「有 openid 的审核人（厂长/管理员）确实收到了」，
   *    与 boss.messageCheck（老板不应收到）构成一对正反判据。
   */
  async messageCheck(agent, state) {
    const rows = await db.query(
      `SELECT m.to_openid, u.real_name
         FROM messages m JOIN users u ON u.openid = m.to_openid
        WHERE m.type = 'check_pending_review' AND m.ref_id = ?`,
      [Number(state.checkId)]
    )
    agent.check('盘点待审提醒已投递给审核人（厂长/管理员）', rows.length > 0, 'P1',
      rows.length ? `收件人：${rows.map((r) => r.real_name).join('、')}` : '没有任何有 openid 的审核人收到 check_pending_review')
  },

  /** 预警口径：看板 = 预警明细 = 物料列表 = 仓库汇总（四处必须一致） */
  async warningConsistency(agent) {
    const ov = await agent.call('stats', 'overview', {})
    const ovData = agent.mustOk('看板预警数', ov)
    const board = Number(ovData.warning_count)
    const zero = Number(ovData.zero_count)

    const w1 = await agent.call('stats', 'warning', { page: 1, pageSize: 1 })
    const w1Data = agent.mustOk('预警明细', w1)
    agent.check('预警数：看板=明细', Number(w1Data.total) === board, 'P1',
      `看板 ${board}，明细 ${w1Data.total}`)

    const sl = await agent.call('stats', 'stockList', { showWarningOnly: true, page: 1, pageSize: 1 })
    const slData = agent.mustOk('物料列表预警', sl)
    agent.check('预警数：看板=物料列表', Number(slData.total) === board, 'P1',
      `看板 ${board}，物料列表 ${slData.total}`)

    const ws = await agent.call('stats', 'warehouseSummary', {})
    const wsList = agent.mustOk('仓库汇总', ws).list || []
    const wsSum = wsList.reduce((s, w) => s + Number(w.warning_count || 0), 0)
    agent.check('预警数：看板=仓库汇总合计', wsSum === board, 'P1',
      `看板 ${board}，仓库汇总合计 ${wsSum}`)

    // 零库存：不随分页变化（回归），且与看板 zero_count 一致
    const w200 = await agent.call('stats', 'warning', { page: 1, pageSize: 200 })
    const w200Data = agent.mustOk('预警大页', w200)
    agent.check('零库存数不随分页变化', Number(w1Data.out_of_stock) === Number(w200Data.out_of_stock), 'P1',
      `pageSize=1 时 ${w1Data.out_of_stock}，pageSize=200 时 ${w200Data.out_of_stock}`)

    const zl = await agent.call('stats', 'stockList', { showZeroOnly: true, page: 1, pageSize: 1 })
    const zlData = agent.mustOk('零库存列表', zl)
    agent.check('零库存数：看板=列表', Number(zlData.total) === zero, 'P1',
      `看板 ${zero}，列表 ${zlData.total}`)
  },

  /** 唯一管理员保护：管理员不能把自己降级（防死锁，V3 P0-3） */
  async lastAdminProbe(agent, state) {
    const res = await agent.call('user', 'updateRole', { id: state.adminId, roles: ['boss'] })
    agent.expectFail('唯一管理员降级自己被拒', res, 'P0', 400)

    // 探针无副作用
    const me = await agent.call('user', 'detail', { id: state.adminId })
    const roles = me && me.data && Array.isArray(me.data.roles) ? me.data.roles : []
    agent.check('探针后管理员角色仍在', roles.includes('admin'), 'P0',
      `roles=${JSON.stringify(roles)}`)
  },

  /** 后台用户管理页基本可用 */
  async userManage(agent) {
    const res = await agent.call('user', 'list', { page: 1, pageSize: 5 })
    const data = agent.mustOk('后台用户列表', res)
    agent.check('用户列表非空', Array.isArray(data.list) && data.list.length > 0, 'P1')

    const logs = await agent.call('user', 'logs', { page: 1, pageSize: 5 })
    const logData = agent.mustOk('后台操作日志', logs)
    agent.check('操作日志非空', Array.isArray(logData.list) && logData.list.length > 0, 'P1')
  }
}
