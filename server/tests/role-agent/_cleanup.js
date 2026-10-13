/**
 * 测试收尾清理（单点套件共用）
 * ------------------------------------------------------------
 * 为什么需要：单点套件（director-check / warehouse-split-check / purchase-peritem-check）
 * 都会往**真实库**写测试物料、单据、采购任务、站内消息，而且经常拿真实物料建单。
 * 不自动清的话，用户下次打开小程序「库存流水」「搜物料」就是一屏测试数据。
 *
 * 用法：
 *   const { autoCleanup } = require('./_cleanup')
 *   ...
 *   autoCleanup()             // 跑完最后调一次
 *   autoCleanup(); process.exit(fail ? 1 : 0)
 *
 * 跳过现场：命令行带 --no-cleanup
 * 识别口径见 ../cleanup-test-data.js（**只认测试标记**，不碰真实数据，先备份）
 * ⛔ 安全闸门：非生产且 ALLOW_DESTRUCTIVE=1 才会真清；否则只警告、不执行（见 src/db/destructive-guard.js）
 */
const path = require('path')
const { spawnSync } = require('child_process')
const { checkDestructive } = require('../../src/db/destructive-guard')

function autoCleanup () {
  if (process.argv.includes('--no-cleanup')) {
    console.log('\n（--no-cleanup：保留现场，未清理）')
    return
  }
  const gate = checkDestructive('自动清理测试数据')
  if (!gate.ok) {
    console.log(`\n⚠️ 已跳过自动清理：${gate.reason}`)
    console.log('   如需清理，请确认是本机开发环境并在 server/.env 设置 ALLOW_DESTRUCTIVE=1')
    return
  }
  console.log('\n🧹 收尾：清理本轮测试数据…')
  // ⚠️ 必须 stdio:'inherit'（管道 stdio 在本机会报 EBUSY）
  const r = spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'cleanup-test-data.js'), '--apply'],
    { stdio: 'inherit' }
  )
  if (r.status !== 0) {
    console.log('⚠️ 清理脚本未正常退出，请手动执行：node tests/cleanup-test-data.js --apply')
  }
}

module.exports = { autoCleanup }
