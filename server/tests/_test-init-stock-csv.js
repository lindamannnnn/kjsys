/**
 * 期初库存导入 —— CSV 解析与匹配的单元验证
 * ------------------------------------------------------------
 * 为什么必须有这个测试：
 *   2026-10-20 准备期初导入时发现两个真实故障，都**不会报错**，只会在账上体现：
 *     ① 旧解析器 `line.split(/[,，]/)` 把中文逗号也当分隔符
 *        → 「蒸柜门扣线割，攻牙」「袖套/牛仔，布」这类行整行错位；
 *        也不认双引号 → 「"同昌80A-电极,电咀"」被劈开。
 *     ② 匹配用 `mats.find()` 只取第一个命中
 *        → 生产库 B003-58 同时对应「波纹管螺母」「不锈钢托条」，
 *          第二行的实盘数量会被静默记到第一个物料头上。
 *   两者都是「单据提交成功、库存加上去、但是加错了料」这一类最难查的错误。
 *
 * 跑法：cd server && node tests/_test-init-stock-csv.js
 * 不连数据库、不建任何单据（只 require 解析函数）。
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { parseCsv } = require('../scripts/init-stock')

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`) }
}

function tmpCsv(content) {
  const p = path.join(os.tmpdir(), `init-stock-test-${Date.now()}-${Math.random().toString(16).slice(2)}.csv`)
  fs.writeFileSync(p, content, 'utf8')
  return p
}

console.log('\n=== 1. 带逗号 / 引号 / BOM 的 CSV 解析 ===')
{
  const csv = '\uFEFF仓库,编号,名称,规格,实盘数量,期初单价\n' +
    '配件仓,B003-58,波纹管螺母,1寸,12,3.5\n' +
    '配件仓,B003-59,"同昌80A-电极,电咀",,5,0\n' +          // ASCII 逗号，被双引号包住
    '配件仓,B003-60,蒸柜门扣线割，攻牙,,7,0\n' +            // 中文逗号，是内容不是分隔符
    '成品仓,,袖套,牛仔，布,9,\n' +                          // 中文逗号 + 空编号 + 空单价
    '配件仓,B003-61,双引号测试,"规格""含引号""",1,2\n'      // "" 转义
  const { rows, bad } = parseCsv(tmpCsv(csv))

  ok(rows.length === 5, '解析出 5 行', `实际 ${rows.length}`)
  ok(bad.length === 0, '无格式错误', bad.join('; '))

  const r2 = rows.find((r) => r.no === 'B003-59')
  ok(r2 && r2.name === '同昌80A-电极,电咀', '双引号内的 ASCII 逗号保留', r2 && r2.name)
  ok(r2 && r2.spec === '', '被引号包住时空规格不错位', r2 && r2.spec)
  ok(r2 && r2.qty === 5, '数量列正确', r2 && String(r2.qty))

  const r3 = rows.find((r) => r.no === 'B003-60')
  ok(r3 && r3.name === '蒸柜门扣线割，攻牙', '中文逗号不被当分隔符', r3 && r3.name)
  ok(r3 && r3.qty === 7, '中文逗号行数量不错位', r3 && String(r3.qty))

  const r4 = rows.find((r) => r.name === '袖套')
  ok(r4 && r4.spec === '牛仔，布', '规格里的中文逗号保留', r4 && r4.spec)
  ok(r4 && r4.qty === 9 && r4.price === 0, '空单价按 0 处理', r4 && `${r4.qty}/${r4.price}`)

  const r5 = rows.find((r) => r.no === 'B003-61')
  ok(r5 && r5.spec === '规格"含引号"', '"" 正确还原成一个引号', r5 && r5.spec)

  ok(rows[0].line === 2, '行号从 2 开始（表头算第 1 行）', String(rows[0].line))
}

console.log('\n=== 2. 非法数量 / 单价 / 列数要被拦下（不能静默变 NaN 或被截断）===')
{
  const csv = '仓库,编号,名称,规格,实盘数量,期初单价\n' +
    '配件仓,A001-1,扒板,600*552*16,10件,5\n' +      // 数量写成「10件」
    '配件仓,A001-2,冷板,,3,1,000\n' +               // 单价未加引号 → 切成 7 列，price 会变 1
    '配件仓,A001-5,门板,,"3","1,000"\n' +           // 单价加了引号 → Number("1,000") = NaN
    '配件仓,A001-3,成品框,,,5\n' +                  // 数量留空 → 0（正常，不报错）
    '配件仓,A001-4,测试料,,-2,0\n' +                // 负数
    '配件仓,A001-6,收尾填错, ,2,0,,\n'               // 行尾多余逗号 → 应被容忍，不报错
  const { rows, bad } = parseCsv(tmpCsv(csv))
  ok(rows.length === 6, '仍解析出 6 行', `实际 ${rows.length}`)
  ok(bad.some((m) => m.includes('10件')), '「10件」被判为非法数量', bad.join(' ; '))
  ok(bad.some((m) => m.includes('列，应为 6 列')), '单价未加引号的 7 列行被拦下', bad.join(' ; '))
  ok(bad.some((m) => m.includes('期初单价') && m.includes('1,000')), '引号内的 "1,000" 被判为非法单价', bad.join(' ; '))
  ok(bad.some((m) => m.includes('-2')), '负数被判为非法', bad.join(' ; '))
  ok(!bad.some((m) => m.includes('收尾填错')), '行尾多余逗号被容忍，不误报', bad.join(' ; '))
}

console.log('\n=== 3. 对照实验：旧解析器在同一条数据上确实会错 ===')
{
  // 复刻旧实现，证明它真的会挂（不是"理论上可能"）
  const oldSplit = (line) => line.split(/[,，]/).map((s) => s.trim())
  const line = '配件仓,B003-60,蒸柜门扣线割，攻牙,,7,0'
  const oldCols = oldSplit(line)
  const newCols = parseCsv(tmpCsv('仓库,编号,名称,规格,实盘数量,期初单价\n' + line)).rows[0]

  ok(oldCols.length === 7, '旧实现把这一行劈成了 7 列（应为 6）', String(oldCols.length))
  ok(oldCols[2] === '蒸柜门扣线割', '旧实现的「名称」被截断', oldCols[2])
  ok(oldCols[3] === '攻牙', '旧实现把名称后半段当成了「规格」', oldCols[3])
  ok(newCols.name === '蒸柜门扣线割，攻牙' && newCols.qty === 7, '新实现名称完整、数量正确',
    `${newCols.name} / ${newCols.qty}`)

  const quoted = '配件仓,B003-59,"同昌80A-电极,电咀",,5,0'
  const oldQ = oldSplit(quoted)
  ok(oldQ[2].startsWith('"'), '旧实现把左引号留在了字段里', oldQ[2])
  ok(oldQ.length === 7, '旧实现在带引号逗号行上同样错位', String(oldQ.length))
}

console.log('\n=== 4. 真实模板（生产导出 1906 条）能整份解析 ===')
{
  const f = path.join(__dirname, '..', '..', 'docs', '期初库存导入模板-20261020.csv')
  if (!fs.existsSync(f)) {
    console.log('  - 跳过：模板文件不存在')
  } else {
    const { rows, bad } = parseCsv(f)
    ok(rows.length === 1906, '解析出 1906 行', `实际 ${rows.length}`)
    ok(bad.length === 0, '无格式错误', bad.slice(0, 3).join('; '))
    const names = rows.map((r) => r.name)
    ok(names.includes('同昌80A-电极,电咀'), '含 ASCII 逗号的物料名完整')
    ok(names.includes('蒸柜门扣线割，攻牙'), '含中文逗号的物料名完整')
    ok(rows.every((r) => r.warehouse === '配件仓' || r.warehouse === '成品仓'), '仓库值只有两种')
    const b58 = rows.filter((r) => r.no === 'B003-58')
    ok(b58.length === 2, 'B003-58 确实有两行（重复编号，需人工分配唯一编号）', `实际 ${b58.length}`)
    ok(new Set(b58.map((r) => r.name)).size === 2, '两行指向两个不同物料名',
      b58.map((r) => r.name).join(' / '))
  }
}

console.log(`\n${'='.repeat(50)}`)
console.log(fail === 0 ? `✅ 全部通过（${pass} 项）` : `❌ ${fail} 项失败 / 共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)
