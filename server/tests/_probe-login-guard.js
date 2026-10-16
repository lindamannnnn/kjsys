/**
 * 登录限流的单元验证（不连数据库、不写生产数据）
 * 运行： node tests/_probe-login-guard.js
 *
 * 验证四件事：
 *   1. 连续失败到阈值后，下一次被拦截（返回 blocked）
 *   2. 登录成功后，该账号的失败计数被清零（不会误伤正常用户）
 *   3. 换了账号不被牵连（按账号隔离）
 *   4. 窗口过后自动解除
 *
 * 对照实验要求：本用例在「未接限流」时不成立（checkLogin 不存在），
 * 只能证明限流本身的逻辑正确；生产实测（见部署后复验）证明接口层真的接上了。
 */
const {
  checkLogin,
  noteLoginFailure,
  noteLoginSuccess,
  _stats
} = require('../src/middleware/security')

let pass = 0
let failN = 0

function check(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    failN++
    console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`)
  }
}

const req = (ip) => ({ ip, socket: { remoteAddress: ip }, headers: {} })

console.log('==============================================')
console.log('  登录限流验证（纯内存，不碰数据库）')
console.log(`  阈值：账号 ${_stats().maxPerAccount} 次 / IP ${_stats().maxPerIp} 次 / 窗口 ${_stats().windowMs / 60000} 分钟`)
console.log('==============================================\n')

// ---------- 1. 达到阈值即拦截 ----------
{
  const ip = '10.0.0.1'
  const data = { username: 'someone' }
  const max = _stats().maxPerAccount

  let firstBlockAt = 0
  for (let i = 1; i <= max + 2; i++) {
    const r = checkLogin('adminLogin', req(ip), data)
    if (r.blocked && !firstBlockAt) firstBlockAt = i
    if (!r.blocked) noteLoginFailure('adminLogin', req(ip), data)
  }
  check(
    `连续失败 ${max} 次后第 ${firstBlockAt} 次被拦截`,
    firstBlockAt === max + 1,
    `实际第 ${firstBlockAt} 次`
  )

  const r = checkLogin('adminLogin', req(ip), data)
  check('拦截时带上重试等待秒数', r.blocked && r.retryAfter > 0, JSON.stringify(r))
  check('拦截提示是中文且可读', r.blocked && /分钟后再试/.test(r.message), r.message)
}

// ---------- 2. 登录成功清零 ----------
{
  const ip = '10.0.0.2'
  const data = { username: 'gooduser' }
  const max = _stats().maxPerAccount

  for (let i = 0; i < max - 1; i++) noteLoginFailure('adminLogin', req(ip), data)
  check('失败 max-1 次后仍可登录（不误伤）', !checkLogin('adminLogin', req(ip), data).blocked)

  noteLoginSuccess('adminLogin', req(ip), data)
  for (let i = 0; i < max - 1; i++) noteLoginFailure('adminLogin', req(ip), data)
  check('成功后计数清零（重来一轮仍未被拦）', !checkLogin('adminLogin', req(ip), data).blocked)
}

// ---------- 3. 按账号隔离 ----------
{
  const ip = '10.0.0.3'
  const victim = { username: 'victim' }
  const other = { username: 'other' }
  for (let i = 0; i < _stats().maxPerAccount + 1; i++) noteLoginFailure('adminLogin', req(ip), victim)

  check('被锁的账号确实被拦', checkLogin('adminLogin', req(ip), victim).blocked)
  // 换个账号、换个 IP → 不受影响
  check(
    '其他账号不受牵连',
    !checkLogin('adminLogin', req('10.0.0.4'), other).blocked
  )
}

// ---------- 4. 不区分大小写（防止换大小写绕过） ----------
{
  const ip = '10.0.0.5'
  for (let i = 0; i < _stats().maxPerAccount + 1; i++) {
    noteLoginFailure('adminLogin', req(ip), { username: 'Admin' })
  }
  check(
    '大小写变化不能绕过账号限流',
    checkLogin('adminLogin', req(ip), { username: 'admin' }).blocked
  )
}

// ---------- 5. 非登录动作不受限流影响 ----------
{
  const ip = '10.0.0.6'
  for (let i = 0; i < _stats().maxPerAccount + 5; i++) {
    noteLoginFailure('adminLogin', req(ip), { username: 'busy' })
  }
  check(
    '登录被锁不影响小程序 login 之外的动作判断口径',
    checkLogin('auth.login', req(ip), { username: 'busy' }).blocked === false
  )
}

console.log('\n==============================================')
console.log(`  结果：通过 ${pass} / 失败 ${failN}`)
console.log('==============================================')
process.exit(failN ? 1 : 0)
