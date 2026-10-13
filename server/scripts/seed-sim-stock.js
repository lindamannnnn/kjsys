/**
 * ============================================================
 * 模拟库存数据灌入（先做一批模拟数据，生产时再重新录入）
 * ------------------------------------------------------------
 * 背景：库里有 1919 条物料，其中 1906 条库存为 0、均价为 0 ——
 *       这批是「只有档案、从未流转」的料，导致
 *         · 库存预警显示 1900+ 条（把真正的缺货全淹了）
 *         · 库存总值 / 金额类报表全是 0
 *       现在先把它们灌成一批像样的模拟数据，等真实生产数据到位再重新录入。
 *
 * 设计原则：
 *   1. **默认预演**，只有显式 `--apply` 才真正写库
 *   2. **只动库存为 0 的物料**，已经有过库存/流水的物料一律不碰
 *   3. **数量与流水一起写**：每条都补一条 change_type='adjust' 的流水，
 *      保证「流水累加 = 当前库存」对账仍然成立（只改数量不写流水会破坏对账）
 *   4. **可一键还原**：写库前先把原值备份成 JSON，随时能倒回去
 *   5. 所有流水 remark 带 `[模拟数据]` 标记，将来生产时便于识别与清除
 *
 * 用法：
 *   node scripts/seed-sim-stock.js                    # 预演（看分布，不写库）
 *   node scripts/seed-sim-stock.js --apply            # 只灌库存数量
 *   node scripts/seed-sim-stock.js --apply --with-cost # 库存数量 + 采购均价
 *   node scripts/seed-sim-stock.js --restore <备份文件> # 还原到灌之前
 * ============================================================
 */
require('../src/config/env')
const fs = require('fs')
const path = require('path')
const { query, queryOne, execute, withTransaction } = require('../src/db/pool')
const { assertDestructive } = require('../src/db/destructive-guard')

const APPLY = process.argv.includes('--apply')
const WITH_COST = process.argv.includes('--with-cost')
const RESTORE_IDX = process.argv.indexOf('--restore')
const RESTORE_FILE = RESTORE_IDX > -1 ? process.argv[RESTORE_IDX + 1] : null

const SIM_MARK = '[模拟数据]'
const BACKUP_DIR = path.join(__dirname, 'backups')

// ------------------------------------------------------------
// 库存分布：让绝大多数料是充足的，只有极少数触发预警。
// 真实仓库里长期缺货的应该是个位到几十条，不该是上千条。
// 另外库存量与单价反相关：贵的少备、便宜的多备（资金占用），
// 否则 1919 种料每种都堆几十件，一眼就不像真实仓库。
// ------------------------------------------------------------
function pickStock(warning, cost = 62) {
  const w = Number(warning) > 0 ? Number(warning) : 5
  const c = Number(cost) > 0 ? Number(cost) : 62
  const r = Math.random()

  // 缺货 / 需补货：只留很小一部分，用来保证预警功能看得见
  if (r < 0.005) return 0                                                          // 0.5% 缺货
  if (r < 0.02) return Math.max(1, Math.floor(w * (0.3 + Math.random() * 0.6)))    // 1.5% 需补货（触发预警）

  // 单价越高，备货越少
  const hi = c >= 150 ? 3.5 : c >= 40 ? 7 : 13
  const lo = c >= 150 ? 1.2 : c >= 40 ? 2 : 3
  return Math.ceil(w * (lo + Math.random() * (hi - lo)))
}

// ------------------------------------------------------------
// 采购均价：按物料名做稳定分档。
// 同一个名字必须算出同一个价 —— 库里同名的料动辄几十条（同一配件的不同规格行），
// 价格忽高忽低一眼就是假的。
// 档位跨度也刻意压小（相邻档约 1.6 倍），避免名字只差两个字价格差 6 倍。
// 注意：这是估算值，不是真实采购价（真实价等生产数据录入时替换）
// ------------------------------------------------------------
const COST_TIERS = [5, 9, 15, 24, 38, 62, 100, 160, 260, 420]
function pickCost(name) {
  const s = String(name || '')
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return COST_TIERS[h % COST_TIERS.length]
}

// ------------------------------------------------------------
// 还原
// ------------------------------------------------------------
async function restore(file) {
  const full = path.isAbsolute(file) ? file : path.join(process.cwd(), file)
  if (!fs.existsSync(full)) {
    console.error(`找不到备份文件：${full}`)
    process.exit(1)
  }
  const backup = JSON.parse(fs.readFileSync(full, 'utf8'))
  console.log('='.repeat(72))
  console.log(`  还原模拟库存  （备份时间 ${backup.created_at}，共 ${backup.items.length} 条）`)
  console.log('='.repeat(72))

  let done = 0
  await withTransaction(async (conn) => {
    for (const it of backup.items) {
      await execute(
        'UPDATE materials SET current_stock = ?, avg_cost = ? WHERE id = ?',
        [it.current_stock, it.avg_cost, it.id],
        conn
      )
      done++
    }
    // 删掉这次灌进去的模拟流水
    const del = await execute(
      `DELETE FROM stock_logs WHERE change_type = 'adjust' AND remark LIKE ?`,
      [`%${SIM_MARK}%`],
      conn
    )
    console.log(`\n  已还原物料 ${done} 条，删除模拟流水 ${del.affectedRows} 条`)
  })

  console.log('\n  还原完成。建议再跑一次 scripts/_stock-audit.js 复核库存分布。')
}

// ------------------------------------------------------------
// 主流程
// ------------------------------------------------------------
async function main() {
  if (RESTORE_FILE) return restore(RESTORE_FILE)

  // ⛔ 安全闸门：这是**模拟数据**灌入脚本（生产要重新录入真实数据），生产环境禁止执行
  if (APPLY) assertDestructive('模拟库存数据灌入', '将批量改写库存为 0 的物料的库存与均价（模拟数据）')

  console.log('='.repeat(72))
  console.log(`  模拟库存数据灌入  ${APPLY ? '【正式执行】' : '【预演，不写任何数据】'}`)
  console.log(`  口径：库存数量${WITH_COST ? ' + 采购均价' : '（不含均价）'}`)
  console.log('='.repeat(72))

  // 只挑库存为 0 的物料；已经有过库存的不碰
  const targets = await query(
    `SELECT id, name, warehouse_id, warning_stock, current_stock, avg_cost
       FROM materials
      WHERE is_deleted = 0
        AND COALESCE(current_stock, 0) = 0
        AND name NOT LIKE '【测试】%'
        AND name NOT LIKE 'E2E测试料%'
      ORDER BY id`
  )

  console.log(`\n[范围] 库存为 0 且非测试物料：${targets.length} 条`)
  const skipped = await queryOne(
    `SELECT COUNT(*) AS c FROM materials
      WHERE is_deleted = 0 AND (COALESCE(current_stock,0) > 0 OR name LIKE '【测试】%' OR name LIKE 'E2E测试料%')`
  )
  console.log(`[范围] 保持不变（已有库存 / 测试物料）：${skipped.c} 条`)

  // 生成灌入值
  const plan = targets.map((m) => {
    const cost = WITH_COST ? pickCost(m.name) : (Number(m.avg_cost) || 0)
    return {
      id: m.id,
      name: m.name,
      warehouse_id: m.warehouse_id,
      warning_stock: Number(m.warning_stock) || 5,
      before_stock: Number(m.current_stock) || 0,
      before_cost: Number(m.avg_cost) || 0,
      current_stock: pickStock(m.warning_stock, cost || 62),
      avg_cost: cost
    }
  })

  const alarming = plan.filter((p) => p.warning_stock > 0 && p.current_stock < p.warning_stock)
  const zero = plan.filter((p) => p.current_stock === 0)
  const sumStock = plan.reduce((s, p) => s + p.current_stock, 0)
  const sumValue = plan.reduce((s, p) => s + p.current_stock * p.avg_cost, 0)

  console.log('\n[分布] 灌入后这批料的样子：')
  console.log(`   合计库存数量        ：${sumStock}`)
  console.log(`   预计触发预警（<阈值）：${alarming.length} 条（${(alarming.length / Math.max(plan.length, 1) * 100).toFixed(1)}%）`)
  console.log(`   其中缺货（=0）      ：${zero.length} 条`)
  if (WITH_COST) console.log(`   这批料库存总值（估） ：¥${sumValue.toFixed(2)}`)

  console.log('\n[抽样 8 条]：')
  console.log('   id | 物料 | 仓 | 原库存→新库存 | 阈值 | 均价')
  for (const p of plan.slice(0, 8)) {
    console.log(
      `   ${p.id} | ${String(p.name).slice(0, 16)} | ${p.warehouse_id} | ` +
      `${p.before_stock}→${p.current_stock} | ${p.warning_stock} | ${p.avg_cost}`
    )
  }

  if (!plan.length) {
    console.log('\n  没有需要灌入的物料，结束。')
    return
  }

  if (!APPLY) {
    console.log('\n' + '='.repeat(72))
    console.log('  预演结束，未写任何数据')
    console.log('  确认无误后加 --apply 正式执行：')
    console.log(`     node scripts/seed-sim-stock.js --apply${WITH_COST ? ' --with-cost' : ''}`)
    console.log('='.repeat(72))
    return
  }

  // ---- 备份 ----
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupFile = path.join(BACKUP_DIR, `sim-stock-before-${stamp}.json`)
  fs.writeFileSync(backupFile, JSON.stringify({
    created_at: new Date().toISOString(),
    with_cost: WITH_COST,
    items: plan.map((p) => ({
      id: p.id,
      name: p.name,
      current_stock: p.before_stock,
      avg_cost: p.before_cost
    }))
  }, null, 2))
  console.log(`\n[备份] 原值已存到：${backupFile}`)
  console.log(`       要还原执行：node scripts/seed-sim-stock.js --restore "${backupFile}"`)

  // ---- 写库 ----
  console.log('\n[写入] 开始（物料 + 流水一起写，保证对账链完整）…')
  let done = 0
  await withTransaction(async (conn) => {
    for (const p of plan) {
      await execute(
        'UPDATE materials SET current_stock = ?, avg_cost = ? WHERE id = ? AND COALESCE(current_stock, 0) = 0',
        [p.current_stock, p.avg_cost, p.id],
        conn
      )
      await execute(
        `INSERT INTO stock_logs
           (material_id, material_name, warehouse_id, change_type, change_quantity,
            before_stock, after_stock, related_order_id, related_order_type,
            operator_openid, operator_name, remark)
         VALUES (?, ?, ?, 'adjust', ?, ?, ?, '', 'init', ?, ?, ?)`,
        [
          p.id, p.name, p.warehouse_id, p.current_stock,
          p.before_stock, p.current_stock,
          'seed', '模拟数据', `${SIM_MARK} 期初库存灌入（生产数据到位后重新录入）`
        ],
        conn
      )
      done++
    }
  })
  console.log(`[写入] 完成：${done} 条物料 + ${done} 条 adjust 流水`)

  console.log('\n' + '='.repeat(72))
  console.log('  灌入完成。建议接着跑：')
  console.log('     node scripts/_stock-audit.js          # 复核库存分布与预警数')
  console.log('  生产数据到位后要清掉这批模拟值：')
  console.log(`     node scripts/seed-sim-stock.js --restore "${backupFile}"`)
  console.log('='.repeat(72))
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('\n脚本异常：', e)
  process.exit(1)
})
