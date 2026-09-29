/**
 * ============================================================
 * 测试串行锁
 * ------------------------------------------------------------
 * 为什么需要它：
 *   `tests/api-test.js` 和 `tests/verify-frontend-contracts.js` 都在开头记录
 *   「基线 id」，结束时**删掉自己开始之后产生的所有单据与流水**。
 *   两个脚本同时跑时，A 的收尾会把 B 正在造的流水一起删掉
 *   → B 断言「流水累加 = 当前库存」时莫名其妙失败，看起来像代码 bug，其实不是。
 *
 * 机制：借 MySQL 的 GET_LOCK（进程间互斥，连接断开自动释放，不会留下死锁）。
 *
 * 用法：
 *   const { acquireTestLock } = require('./_test-lock')
 *   await acquireTestLock('后端回归测试')
 * ============================================================
 */

const LOCK_NAME = 'shenglong_test_suite'

/** 抢锁；抢不到就打印人话提示并退出（退出码 1） */
async function acquireTestLock(label) {
  const { queryOne } = require('../src/db/pool')
  let got = 0
  try {
    const row = await queryOne('SELECT GET_LOCK(?, 0) AS got', [LOCK_NAME])
    got = row ? Number(row.got) : 0
  } catch (e) {
    // 拿不到锁不该阻断开发，只是失去保护
    console.warn(`  ⚠ 无法获取测试锁（${e.message}），继续执行但无法防止并行冲突`)
    return
  }

  if (got !== 1) {
    console.error(`\n${'='.repeat(60)}`)
    console.error(`  ${label} 无法开始：另一个测试脚本正在占用数据库`)
    console.error('')
    console.error('  原因：两套测试都会「删除自己开始之后产生的所有数据」，')
    console.error('        同时运行会互相删掉对方的单据与流水，')
    console.error('        表现为「流水累加 ≠ 当前库存」这类假故障。')
    console.error('')
    console.error('  处理：等它跑完再跑，或直接用 npm run test:all（已串行）')
    console.error(`${'='.repeat(60)}\n`)
    process.exit(1)
  }
}

/** 主动释放（正常跑完时调用；进程异常退出由 MySQL 自动释放） */
async function releaseTestLock() {
  try {
    const { queryOne } = require('../src/db/pool')
    await queryOne('SELECT RELEASE_LOCK(?) AS r', [LOCK_NAME])
  } catch (e) {
    /* 释放失败无需处理，连接关闭时数据库会兜底 */
  }
}

module.exports = { acquireTestLock, releaseTestLock, LOCK_NAME }
