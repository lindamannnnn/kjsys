/**
 * 岗位 Agent · 老板（dev_boss）
 * 职责：**只读** —— 2026-10-09 用户要求「老板那边审核功能去掉，只需看数据看板 + 库存流水」，
 *      故本用例整体改为「越权必须被拒 + 库存不受影响」的只读边界验证。
 *      审核正例见 admin.reviewCheck 与 tests/role-agent/director-check.js。
 *      另含：权限门 P0 回归探针、看板一致性。
 */
module.exports = {
  id: 'boss',

  /** 盘点审核：老板已被收回（只读边界）→ 必须被拒，且库存不能因此变动 */
  async reviewCheck(agent, state) {
    const id = state.checkId

    const before = await agent.call('material', 'detail', { id: state.A.id })
    const stockBefore = Number(agent.mustOk('审核前查物料A', before).current_stock)

    const res = await agent.call('check', 'review', { id, approve: true, remark: '同意' })
    agent.expectFail('老板盘点审核被拒（已收回，只读）', res, 'P0', 403)

    const after = await agent.call('material', 'detail', { id: state.A.id })
    const stockAfter = Number(agent.mustOk('审核后查物料A', after).current_stock)
    agent.check('老板审核被拒后库存未变', stockAfter === stockBefore, 'P0',
      `审核前 ${stockBefore}，审核后 ${stockAfter}`)
  },

  /** 出库驳回：老板已被收回（只读边界）→ 必须被拒，货不能动 */
  async rejectOutbound(agent, state) {
    const before = await agent.call('material', 'detail', { id: state.A.id })
    const stockBefore = Number(agent.mustOk('驳回前查库存', before).current_stock)

    const res = await agent.call('outbound', 'reject', { id: state.orders.rj, reason: '数量不对，重报' })
    agent.expectFail('老板驳回出库单被拒（已收回，只读）', res, 'P0', 403)

    const after = await agent.call('material', 'detail', { id: state.A.id })
    const stockAfter = Number(agent.mustOk('驳回后查库存', after).current_stock)
    agent.check('驳回被拒后库存未变', stockAfter === stockBefore, 'P0',
      `驳回前 ${stockBefore}，驳回后 ${stockAfter}`)
  },

  /** 消息：2026-10-09 起待审提醒只发 管理员 + 厂长 → 老板**不应**再收到 */
  async messageCheck(agent, state) {
    const res = await agent.call('message', 'list', { page: 1, pageSize: 50 })
    const list = (agent.mustOk('老板查消息', res).list) || []
    const hit = list.find(
      (m) => m.type === 'check_pending_review' && Number(m.ref_id) === Number(state.checkId)
    )
    agent.check('老板不再收到盘点待审通知（审核已归厂长/管理员）', !hit, 'P1',
      hit ? '老板收件箱里仍出现了 check_pending_review' : '')
  },

  /** P0 权限门回归：老板不能造/剥夺/禁用管理员（立场 B） */
  async adminGuardProbes(agent, state, helpers) {
    // 老板凭空造管理员
    const name = `RA_noadmin_R${state.round}_${helpers.RUN}`
    const a1 = await agent.call('user', 'create', {
      username: name, password: 'abc123456', real_name: '越权探针',
      roles: ['admin'], warehouse_ids: [1]
    })
    agent.expectFail('老板 user.create 建管理员被拒', a1, 'P0', 403)
    if (a1 && a1.code === 0) {
      // 熔断：修复失效，立刻禁用这个凭空造出来的管理员
      const row = await helpers.db.queryOne('SELECT id FROM users WHERE username = ?', [name])
      if (row) {
        await agent.call('user', 'disable', { id: row.id })
        helpers.alert(`修复失效！已紧急禁用探针管理员 id=${row.id}`)
      }
    }

    // 老板剥夺管理员角色
    const a3 = await agent.call('user', 'updateRole', { id: state.adminId, roles: ['out'] })
    agent.expectFail('老板剥夺管理员角色被拒', a3, 'P0', 403)

    // 老板禁用管理员
    const a4 = await agent.call('user', 'disable', { id: state.adminId })
    agent.expectFail('老板禁用管理员被拒', a4, 'P0', 403)

    // 确认管理员本人毫发无损（探针没有副作用）
    const me = await agent.call('user', 'detail', { id: state.adminId })
    const okState = me && me.code === 0 && me.data && me.data.status === 'active'
    agent.check('探针后管理员账号仍正常', okState, 'P0',
      okState ? '' : `code=${me && me.code} status=${me && me.data && me.data.status}`)
  },

  /** 审计：越权尝试与主数据改动都留了痕 */
  async auditVerify(agent, state) {
    const denied = await agent.call('user', 'logs', { action: 'permission_denied', page: 1, pageSize: 1 })
    const total = Number(agent.mustOk('查越权日志', denied).total)
    const delta = total - state.baseline.denied
    // 本轮探针：picker 4 + sk 3 + purchaser 3 + boss 3 = 13 次被拒
    agent.check('越权尝试已留痕（≥13条新增）', delta >= 13, 'P1',
      `基线 ${state.baseline.denied} → 现在 ${total}（+${delta}）`)

    const mc = await agent.call('user', 'logs', { action: 'material_create', page: 1, pageSize: 1 })
    const mcTotal = Number(agent.mustOk('查物料建档日志', mc).total)
    agent.check('物料建档已留痕（+2）', mcTotal - state.baseline.materialCreate >= 2, 'P1',
      `基线 ${state.baseline.materialCreate} → 现在 ${mcTotal}`)
  },

  /** 抓老板视角看板（供与后台管理员看板比对） */
  async captureOverview(agent, state) {
    const res = await agent.call('stats', 'overview', {})
    state.overviews.boss = agent.mustOk('老板看板', res)
  }
}
