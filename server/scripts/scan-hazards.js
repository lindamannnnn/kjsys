#!/usr/bin/env node
'use strict'
/**
 * 生产隐患扫描（scan-hazards）
 * ============================================================
 * 和 preflight 的分工：
 *   · preflight  —— 上线**前**，查「代码 / 库 / 部署」是否一致（静态对撞）
 *   · 本脚本     —— 上线**后**，查**数据里已经埋着的地雷**（运行时隐患）
 *
 * 为什么需要它（2026-10-16 用户原话：「我真的怕了你，做了这么多测试还是有 bug」）：
 *   功能测试只能证明「我点的那条路通」，证明不了：
 *     · 数据脏了会不会炸（孤儿引用、状态与扣账标记不自洽）
 *     · 库结构允许但业务不该发生的事（负库存、超收、金额对不上）
 *     · 迟早会撑爆的边界（接近列长上限、日志无上限）
 *   这些的共同点：**现在不报错，等某天某个操作触发才炸**，且往往已经静默错很久。
 *
 * ⚠️ 本脚本**只读**：仅执行 SELECT，任何写操作会被代码直接拦下（见 assertReadOnly）。
 *    扫描生产库不需要停服务，也不产生任何业务数据。
 *
 * 用法：
 *   cd server && npm run scan:hazards
 *   npm run scan:hazards -- --json           # 结构化输出（存档 / 挂 CI）
 *   npm run scan:hazards -- --all            # 连「通过」的检查项也列出来
 *   LEVEL=RED npm run scan:hazards           # 只看严重项
 *
 * 退出码：0 = 无严重项；1 = 有 🔴 严重项（必须先处理）；2 = 扫描自身故障
 * ============================================================
 */
const { pool } = require('../src/db/pool')

const BAR = '='.repeat(64)
const LEVELS = {
  RED: { icon: '🔴', name: '严重', hint: '会导致数据错误 / 功能失效，应尽快处理' },
  ORANGE: { icon: '🟠', name: '中等', hint: '特定操作下会出问题，建议排期处理' },
  YELLOW: { icon: '🟡', name: '提示', hint: '目前无害，但值得知道 / 防止恶化' }
}
const LEVEL_ORDER = ['RED', 'ORANGE', 'YELLOW']

/** 只读护栏：任何非 SELECT 语句直接拒绝执行 */
function assertReadOnly(sql) {
  const s = String(sql).trim().toLowerCase()
  if (!/^(select|with)\b/.test(s)) {
    throw new Error(`[只读护栏] 拒绝执行非查询语句：${s.slice(0, 60)}…`)
  }
  if (/\b(insert|update|delete|drop|alter|truncate|replace|grant|create)\b/.test(s)) {
    throw new Error(`[只读护栏] 语句里出现写操作关键字：${s.slice(0, 60)}…`)
  }
}

async function count(sql) {
  assertReadOnly(sql)
  const [rows] = await pool.query(sql)
  return Number(rows[0] ? Object.values(rows[0])[0] : 0)
}

async function sample(sql, n = 3) {
  assertReadOnly(sql)
  const [rows] = await pool.query(`${sql} LIMIT ${Number(n)}`)
  return rows
}

/**
 * 检查项定义
 *   id      标识（报告里用来引用，别改）
 *   level   RED / ORANGE / YELLOW
 *   title   一句话说清「什么不对」
 *   why     为什么危险（后果），写给非技术读者
 *   count   返回数量的 SQL
 *   sample  返回样例行的 SQL（可选）
 *   js      自定义检查（返回 {count, rows}），用于 JSON 列这类 SQL 不好表达的（可选）
 */
const CHECKS = [
  // ---------------- 引用完整性（schema 里明确不建外键 → 孤儿只能靠扫） ----------------
  {
    id: 'ORPHAN-ITEM-MATERIAL',
    level: 'RED',
    title: '单据明细指向的物料已不存在',
    why: '明细与物料是「弱引用」——物料被删后明细成孤儿，单据详情会缺行或报错，库存也没法回补',
    count: `SELECT (
      (SELECT COUNT(*) FROM outbound_order_items  i LEFT JOIN materials m ON m.id=i.material_id WHERE m.id IS NULL)
    + (SELECT COUNT(*) FROM inbound_order_items   i LEFT JOIN materials m ON m.id=i.material_id WHERE m.id IS NULL)
    + (SELECT COUNT(*) FROM purchase_task_items   i LEFT JOIN materials m ON m.id=i.material_id WHERE m.id IS NULL)
    + (SELECT COUNT(*) FROM stock_check_items     i LEFT JOIN materials m ON m.id=i.material_id WHERE m.id IS NULL)
    + (SELECT COUNT(*) FROM stock_logs            i LEFT JOIN materials m ON m.id=i.material_id WHERE m.id IS NULL)
    ) AS n`,
    sample: `SELECT 'outbound_order_items' AS 来源, i.id, i.order_id AS 父单, i.material_id FROM outbound_order_items i LEFT JOIN materials m ON m.id=i.material_id WHERE m.id IS NULL
      UNION ALL SELECT 'inbound_order_items', i.id, i.order_id, i.material_id FROM inbound_order_items i LEFT JOIN materials m ON m.id=i.material_id WHERE m.id IS NULL
      UNION ALL SELECT 'purchase_task_items', i.id, i.task_id, i.material_id FROM purchase_task_items i LEFT JOIN materials m ON m.id=i.material_id WHERE m.id IS NULL
      UNION ALL SELECT 'stock_check_items', i.id, i.check_id, i.material_id FROM stock_check_items i LEFT JOIN materials m ON m.id=i.material_id WHERE m.id IS NULL`
  },
  {
    id: 'ORPHAN-ITEM-PARENT',
    level: 'RED',
    title: '明细的父单（出库/入库/采购/盘点）不存在',
    why: '明细挂着但主单没了 → 该明细永远不会被任何页面展示，也不会参与对账，属静默数据丢失',
    count: `SELECT (
      (SELECT COUNT(*) FROM outbound_order_items i LEFT JOIN outbound_orders p ON p.id=i.order_id WHERE p.id IS NULL)
    + (SELECT COUNT(*) FROM inbound_order_items  i LEFT JOIN inbound_orders  p ON p.id=i.order_id WHERE p.id IS NULL)
    + (SELECT COUNT(*) FROM purchase_task_items  i LEFT JOIN purchase_tasks  p ON p.id=i.task_id  WHERE p.id IS NULL)
    + (SELECT COUNT(*) FROM stock_check_items    i LEFT JOIN stock_checks    p ON p.id=i.check_id WHERE p.id IS NULL)
    ) AS n`,
    sample: `SELECT 'outbound_order_items' AS 来源, i.id AS 明细, i.order_id AS 父单id FROM outbound_order_items i LEFT JOIN outbound_orders p ON p.id=i.order_id WHERE p.id IS NULL
      UNION ALL SELECT 'inbound_order_items', i.id, i.order_id FROM inbound_order_items i LEFT JOIN inbound_orders p ON p.id=i.order_id WHERE p.id IS NULL
      UNION ALL SELECT 'purchase_task_items', i.id, i.task_id FROM purchase_task_items i LEFT JOIN purchase_tasks p ON p.id=i.task_id WHERE p.id IS NULL
      UNION ALL SELECT 'stock_check_items', i.id, i.check_id FROM stock_check_items i LEFT JOIN stock_checks p ON p.id=i.check_id WHERE p.id IS NULL`
  },
  {
    id: 'ORPHAN-WAREHOUSE',
    level: 'RED',
    title: '单据 / 物料 / 流水 指向的仓库不存在',
    why: '仓库被删后，这些记录会从「按仓筛选」的列表里彻底消失（连盘点都扫不到）',
    count: `SELECT (
      (SELECT COUNT(*) FROM materials       x LEFT JOIN warehouses w ON w.id=x.warehouse_id WHERE w.id IS NULL)
    + (SELECT COUNT(*) FROM outbound_orders x LEFT JOIN warehouses w ON w.id=x.warehouse_id WHERE w.id IS NULL)
    + (SELECT COUNT(*) FROM inbound_orders  x LEFT JOIN warehouses w ON w.id=x.warehouse_id WHERE w.id IS NULL)
    + (SELECT COUNT(*) FROM stock_checks    x LEFT JOIN warehouses w ON w.id=x.warehouse_id WHERE w.id IS NULL)
    + (SELECT COUNT(*) FROM purchase_tasks  x LEFT JOIN warehouses w ON w.id=x.warehouse_id WHERE w.id IS NULL)
    ) AS n`,
    sample: `SELECT 'materials' AS 来源, x.id, x.warehouse_id FROM materials x LEFT JOIN warehouses w ON w.id=x.warehouse_id WHERE w.id IS NULL
      UNION ALL SELECT 'outbound_orders', x.id, x.warehouse_id FROM outbound_orders x LEFT JOIN warehouses w ON w.id=x.warehouse_id WHERE w.id IS NULL
      UNION ALL SELECT 'inbound_orders', x.id, x.warehouse_id FROM inbound_orders x LEFT JOIN warehouses w ON w.id=x.warehouse_id WHERE w.id IS NULL
      UNION ALL SELECT 'purchase_tasks', x.id, x.warehouse_id FROM purchase_tasks x LEFT JOIN warehouses w ON w.id=x.warehouse_id WHERE w.id IS NULL`
  },
  {
    id: 'ORPHAN-SUPPLIER',
    level: 'ORANGE',
    title: '入库单挂的供应商已被删除',
    why: '供应商删除是软删（is_deleted=1），若入库单仍引用它，对账/开票时查不到供应商信息',
    count: `SELECT COUNT(*) AS n FROM inbound_orders o
              JOIN suppliers s ON s.id = o.supplier_id
             WHERE o.supplier_id IS NOT NULL AND o.supplier_id > 0 AND s.is_deleted = 1`,
    sample: `SELECT o.id AS 入库单, o.order_no, o.supplier_id, s.name FROM inbound_orders o
              JOIN suppliers s ON s.id = o.supplier_id
             WHERE o.supplier_id IS NOT NULL AND o.supplier_id > 0 AND s.is_deleted = 1`
  },
  {
    id: 'SOFTDEL-IN-USE',
    level: 'ORANGE',
    title: '已删除的物料仍被「未结单据」引用',
    why: '物料软删了，但还有进行中的单子挂着它 —— 点进去显示不出名称，流程走不下去',
    count: `SELECT (
      (SELECT COUNT(*) FROM outbound_order_items i JOIN materials m ON m.id=i.material_id JOIN outbound_orders p ON p.id=i.order_id
        WHERE m.is_deleted=1 AND p.status NOT IN ('completed','cancelled','rejected'))
    + (SELECT COUNT(*) FROM purchase_task_items i JOIN materials m ON m.id=i.material_id JOIN purchase_tasks p ON p.id=i.task_id
        WHERE m.is_deleted=1 AND p.status NOT IN ('received','cancelled'))
    ) AS n`,
    sample: `SELECT '出库明细' AS 来源, i.id AS 明细, m.name AS 物料, p.order_no AS 单号, p.status AS 单据状态
              FROM outbound_order_items i JOIN materials m ON m.id=i.material_id JOIN outbound_orders p ON p.id=i.order_id
             WHERE m.is_deleted=1 AND p.status NOT IN ('completed','cancelled','rejected')
      UNION ALL SELECT '采购明细', i.id, m.name, p.task_no, p.status
              FROM purchase_task_items i JOIN materials m ON m.id=i.material_id JOIN purchase_tasks p ON p.id=i.task_id
             WHERE m.is_deleted=1 AND p.status NOT IN ('received','cancelled')`
  },

  // ---------------- 库存账实（最要命的一类） ----------------
  {
    id: 'STOCK-NEGATIVE',
    level: 'RED',
    title: '物料库存为负数',
    why: '负库存意味着出库时扣多了（或入库漏记）—— 账已错，越晚发现越难追',
    count: `SELECT COUNT(*) AS n FROM materials WHERE is_deleted = 0 AND current_stock < 0`,
    sample: `SELECT id, name, spec, current_stock, unit FROM materials WHERE is_deleted = 0 AND current_stock < 0 ORDER BY current_stock ASC`
  },
  {
    id: 'STOCK-VS-LOGS',
    level: 'ORANGE',
    title: '物料库存 与 库存流水累计 对不上',
    why: '两者应恒等（库存是流水累计的结果）。对不上 = 有绕过流水的改动，或历史迁移没对齐',
    count: `SELECT COUNT(*) AS n FROM (
              SELECT m.id
                FROM materials m
                LEFT JOIN (SELECT material_id, SUM(change_quantity) AS s FROM stock_logs GROUP BY material_id) l
                       ON l.material_id = m.id
               WHERE m.is_deleted = 0
                 AND ABS(m.current_stock - COALESCE(l.s, 0)) > 0.0005
            ) t`,
    sample: `SELECT m.id, m.name, m.spec, m.current_stock AS 账面库存, COALESCE(l.s,0) AS 流水累计,
                   (m.current_stock - COALESCE(l.s,0)) AS 差额
              FROM materials m
              LEFT JOIN (SELECT material_id, SUM(change_quantity) AS s FROM stock_logs GROUP BY material_id) l
                     ON l.material_id = m.id
             WHERE m.is_deleted = 0 AND ABS(m.current_stock - COALESCE(l.s, 0)) > 0.0005
             ORDER BY ABS(m.current_stock - COALESCE(l.s,0)) DESC`
  },
  {
    id: 'STOCK-LOG-BREAK',
    level: 'ORANGE',
    title: '库存流水自身不自洽（after - before ≠ 变动量）',
    why: '流水的 before/after 是审计命脉。这一条错，意味着任何时候都算不出「当时库存是多少」',
    count: `SELECT COUNT(*) AS n FROM stock_logs WHERE ABS((after_stock - before_stock) - change_quantity) > 0.0005`,
    sample: `SELECT id, material_name, change_type, before_stock, change_quantity, after_stock, created_at
              FROM stock_logs WHERE ABS((after_stock - before_stock) - change_quantity) > 0.0005`
  },
  {
    id: 'OUTSTATUS-DEDUCT',
    level: 'RED',
    title: '出库单「状态」与「是否已扣库存」不自洽',
    why: `规则：收货才扣（stock_deducted=1）。不自洽的后果——
            已完成却没扣 → 库存永远不减少（东西领走了账上还在）；
            已作废却扣了 → 库存被白扣，且没人回补`,
    count: `SELECT COUNT(*) AS n FROM outbound_orders
             WHERE is_deleted = 0 AND (
                  (status = 'completed' AND stock_deducted = 0)
               OR (status = 'confirmed' AND stock_deducted = 0)
               OR (status IN ('cancelled','rejected') AND stock_deducted = 1)
               OR (status IN ('pending','picking','receiving') AND stock_deducted = 1)
             )`,
    sample: `SELECT id, order_no, status, stock_deducted,
                   CASE
                     WHEN status='completed' AND stock_deducted=0 THEN '已完成但未扣库存'
                     WHEN status='confirmed' AND stock_deducted=0 THEN '历史状态confirmed且未扣库存（迁移遗漏）'
                     WHEN status IN ('cancelled','rejected') AND stock_deducted=1 THEN '已作废/驳回但已扣库存'
                     ELSE '进行中却已扣库存'
                   END AS 问题, created_at
              FROM outbound_orders
             WHERE is_deleted = 0 AND (
                  (status = 'completed' AND stock_deducted = 0)
               OR (status = 'confirmed' AND stock_deducted = 0)
               OR (status IN ('cancelled','rejected') AND stock_deducted = 1)
               OR (status IN ('pending','picking','receiving') AND stock_deducted = 1)
             )`
  },
  {
    // ⚠️ 本系统入库的真实语义（务必按代码写，别凭直觉）：
    //   submit  → **立刻加库存**（addForInbound），单子落库时 status 就是 'pending'
    //   confirm → 只把 status 改成 'confirmed'（库存不动，这一步是仓管核对金额/单据）
    //   cancel  → 回退库存（写 change_type='inbound_cancel'、delta 为负）并置 'cancelled'
    //   ⇒ 所以「status=pending 却有入库流水」是**正常的**（曾据此误报，已修）。
    //     真正该报的是下面这两种：
    id: 'IN-CANCEL-NET',
    level: 'RED',
    title: '入库单已作废，但库存没有完全回退',
    why: '作废会把当初加进去的库存退掉，因此该单的流水净额必须是 0。不为 0 = 库存多着（账实不符）',
    count: `SELECT COUNT(*) AS n FROM inbound_orders o
             WHERE o.is_deleted = 0 AND o.status = 'cancelled'
               AND ABS(COALESCE((SELECT SUM(l.change_quantity) FROM stock_logs l
                                  WHERE l.related_order_id = o.order_no), 0)) > 0.0005`,
    sample: `SELECT o.id, o.order_no, o.status,
                   COALESCE((SELECT SUM(l.change_quantity) FROM stock_logs l WHERE l.related_order_id = o.order_no), 0) AS 流水净额,
                   o.cancelled_at
              FROM inbound_orders o
             WHERE o.is_deleted = 0 AND o.status = 'cancelled'
               AND ABS(COALESCE((SELECT SUM(l.change_quantity) FROM stock_logs l WHERE l.related_order_id = o.order_no), 0)) > 0.0005`
  },
  {
    id: 'IN-CONFIRMED-NOLOG',
    level: 'ORANGE',
    title: '入库单已确认，却没有入库流水',
    why: '提交时就该加库存。已确认却查不到流水 = 货收进来了但账上没加（或流水被清过）',
    count: `SELECT COUNT(*) AS n FROM inbound_orders o
             WHERE o.is_deleted = 0 AND o.status = 'confirmed'
               AND NOT EXISTS (SELECT 1 FROM stock_logs l
                                WHERE l.related_order_id = o.order_no AND l.change_type = 'inbound')`,
    sample: `SELECT o.id, o.order_no, o.type, o.total_price, o.confirmed_at
              FROM inbound_orders o
             WHERE o.is_deleted = 0 AND o.status = 'confirmed'
               AND NOT EXISTS (SELECT 1 FROM stock_logs l
                                WHERE l.related_order_id = o.order_no AND l.change_type = 'inbound')`
  },
  {
    id: 'IN-PENDING-EMPTY',
    level: 'YELLOW',
    title: '入库单既没有流水、也没有明细（空壳单）',
    why: '提交是一个事务，正常不该留下半成品。真出现说明有绕过事务的写入',
    count: `SELECT COUNT(*) AS n FROM inbound_orders o
             WHERE o.is_deleted = 0
               AND NOT EXISTS (SELECT 1 FROM inbound_order_items i WHERE i.order_id = o.id)
               AND NOT EXISTS (SELECT 1 FROM stock_logs l WHERE l.related_order_id = o.order_no)`,
    sample: `SELECT id, order_no, status, created_at FROM inbound_orders o
             WHERE o.is_deleted = 0
               AND NOT EXISTS (SELECT 1 FROM inbound_order_items i WHERE i.order_id = o.id)
               AND NOT EXISTS (SELECT 1 FROM stock_logs l WHERE l.related_order_id = o.order_no)`
  },

  // ---------------- 盘点 ----------------
  {
    id: 'CHECK-INCOMPLETE',
    level: 'ORANGE',
    title: '已完成的盘点单里还有「没录入实盘数」的明细',
    why: '盘点完成却漏录 → 账实差异没被发现，等于这次白盘了',
    count: `SELECT COUNT(*) AS n FROM stock_checks c JOIN stock_check_items i ON i.check_id = c.id
             WHERE c.status = 'completed' AND (i.actual_stock IS NULL OR i.is_checked = 0)`,
    sample: `SELECT c.id AS 盘点单, c.check_no, c.status, COUNT(*) AS 未录入明细数
              FROM stock_checks c JOIN stock_check_items i ON i.check_id = c.id
             WHERE c.status = 'completed' AND (i.actual_stock IS NULL OR i.is_checked = 0)
             GROUP BY c.id, c.check_no, c.status`
  },
  {
    id: 'CHECK-DIFF-CALC',
    level: 'ORANGE',
    title: '盘点差异 ≠ 实盘 - 账面',
    why: '差异是后面调账的依据，算错了就会按错的数去调库存',
    count: `SELECT COUNT(*) AS n FROM stock_check_items
             WHERE actual_stock IS NOT NULL AND difference IS NOT NULL
               AND ABS(difference - (actual_stock - book_stock)) > 0.0005`,
    sample: `SELECT i.id, i.material_name, i.book_stock, i.actual_stock, i.difference,
                   (i.actual_stock - i.book_stock) AS 应为
              FROM stock_check_items i
             WHERE i.actual_stock IS NOT NULL AND i.difference IS NOT NULL
               AND ABS(i.difference - (i.actual_stock - i.book_stock)) > 0.0005`
  },

  // ---------------- 权限 / 身份（与生产事故同源，最容易复发） ----------------
  {
    id: 'ACTIVE-NO-ROLE',
    level: 'RED',
    title: '在职账号没有任何角色',
    why: '能登录但什么都看不到（页面空白 / 全 403）。生产上真实发生过：扫码自动建档后没人给角色',
    count: `SELECT COUNT(*) AS n FROM users
             WHERE status = 'active' AND (roles IS NULL OR JSON_LENGTH(roles) = 0)`,
    sample: `SELECT id, COALESCE(username,'(无)') AS 账号, real_name, nickname, status, created_at
              FROM users WHERE status = 'active' AND (roles IS NULL OR JSON_LENGTH(roles) = 0)`
  },
  {
    id: 'PENDING-ZOMBIE',
    level: 'YELLOW',
    title: '长期挂在「待审核」的账号',
    why: '扫码的人进了系统却没人审核 → 他自己看到「账号审核中」，你以为他还没来过',
    count: `SELECT COUNT(*) AS n FROM users WHERE status = 'pending'`,
    sample: `SELECT id, COALESCE(username,'(无)') AS 账号, real_name, nickname, created_at,
                   TIMESTAMPDIFF(DAY, created_at, NOW()) AS 已挂天数
              FROM users WHERE status = 'pending' ORDER BY created_at ASC`
  },
  {
    id: 'IDENT-NULL-EMPTY',
    level: 'YELLOW',
    title: '身份列出现「空串」而非 NULL',
    why: `本系统身份口径 = COALESCE(openid, username)。空串会「占位」——
            唯一索引 uk_user_openid 上两个空串会互相冲突（改数据时踩过）`,
    count: `SELECT (
      (SELECT COUNT(*) FROM users WHERE openid = '')
    + (SELECT COUNT(*) FROM users WHERE username = '')
    ) AS n`,
    sample: `SELECT id, COALESCE(NULLIF(username,''),'(空串)') AS 账号, openid, status FROM users WHERE openid = '' OR username = ''`
  },
  {
    id: 'MISSING-BOSS-OPENID',
    level: 'ORANGE',
    title: '预警配置指向的老板账号已不存在',
    why: '库存预警会推给这些人。账号没了 → 预警发出去没人收，且不报错（静默失效）',
    js: async () => {
      const [rows] = await pool.query(`SELECT boss_openids FROM settings WHERE id = 1`)
      const ids = rows[0] && rows[0].boss_openids ? rows[0].boss_openids : []
      const arr = Array.isArray(ids) ? ids : []
      if (!arr.length) return { count: 0, rows: [] }
      const [users] = await pool.query(
        `SELECT openid, username FROM users WHERE status = 'active'`
      )
      const known = new Set()
      for (const u of users) {
        if (u.openid) known.add(String(u.openid))
        if (u.username) known.add(String(u.username))
      }
      const bad = arr.filter((x) => !known.has(String(x)))
      return { count: bad.length, rows: bad.map((x) => ({ 收不到预警的账号: String(x).slice(0, 12) + '…' })) }
    }
  },
  {
    id: 'USER-WH-ORPHAN',
    level: 'ORANGE',
    title: '账号可操作的仓库里有已不存在的',
    why: 'warehouse_ids 限定了这个账号能看哪些仓。含失效 id → 权限判断里多了个幽灵仓库',
    js: async () => {
      const [rows] = await pool.query(
        `SELECT id, COALESCE(username,'(无)') AS username, real_name, warehouse_ids
           FROM users WHERE warehouse_ids IS NOT NULL`
      )
      const [whs] = await pool.query(`SELECT id FROM warehouses WHERE is_deleted = 0`)
      const ok = new Set(whs.map((w) => Number(w.id)))
      const bad = []
      for (const u of rows) {
        const arr = Array.isArray(u.warehouse_ids) ? u.warehouse_ids : []
        const ghosts = arr.map(Number).filter((x) => x && !ok.has(x))
        if (ghosts.length) bad.push({ 账号: u.username, 姓名: u.real_name, 幽灵仓库: ghosts.join(',') })
      }
      return { count: bad.length, rows: bad }
    }
  },

  // ---------------- 采购链路 ----------------
  {
    id: 'PURCHASE-QTY',
    level: 'ORANGE',
    title: '采购明细数量关系异常（超收 / 入库超过实到）',
    why: '实到 > 需求 = 多买；已入库 > 实到 = 账上加多了。都会让库存和实际对不上',
    count: `SELECT COUNT(*) AS n FROM purchase_task_items
             WHERE received_qty > quantity + 0.0005
                OR stocked_qty > received_qty + 0.0005
                OR stocked_qty > quantity + 0.0005`,
    sample: `SELECT i.id, i.task_id AS 采购单, i.material_name, i.quantity AS 需求,
                   i.received_qty AS 实到, i.stocked_qty AS 已入库, i.receive_status,
                   CASE WHEN i.received_qty > i.quantity + 0.0005 THEN '超收'
                        WHEN i.stocked_qty > i.received_qty + 0.0005 THEN '入库超过实到'
                        ELSE '入库超过需求' END AS 问题
              FROM purchase_task_items i
             WHERE i.received_qty > i.quantity + 0.0005
                OR i.stocked_qty > i.received_qty + 0.0005
                OR i.stocked_qty > i.quantity + 0.0005`
  },
  {
    id: 'PURCHASE-PRICE-ZERO',
    level: 'YELLOW',
    title: '采购明细有数量但单价为 0',
    why: '要么漏录价（成本算不准），要么是真的免费赠品 —— 需要人工确认是哪一种',
    count: `SELECT COUNT(*) AS n FROM purchase_task_items i JOIN purchase_tasks t ON t.id = i.task_id
             WHERE t.status IN ('purchased','receiving','received') AND i.quantity > 0 AND i.unit_price = 0`,
    sample: `SELECT i.id, t.task_no, t.status, i.material_name, i.quantity, i.unit_price
              FROM purchase_task_items i JOIN purchase_tasks t ON t.id = i.task_id
             WHERE t.status IN ('purchased','receiving','received') AND i.quantity > 0 AND i.unit_price = 0`
  },
  {
    id: 'PURCHASE-RECEIVED-NO-IN',
    level: 'ORANGE',
    title: '采购单已「收料入库」却没关联入库单',
    why: '状态说入库了，但没有入库单 → 库存可能压根没加。这正是「货到了账上没货」的典型',
    count: `SELECT COUNT(*) AS n FROM purchase_tasks
             WHERE status = 'received' AND (inbound_order_id IS NULL OR inbound_order_id = 0)
               AND (inbound_order_no IS NULL OR inbound_order_no = '')`,
    sample: `SELECT id, task_no, status, received_at, total_amount FROM purchase_tasks
             WHERE status = 'received' AND (inbound_order_id IS NULL OR inbound_order_id = 0)
               AND (inbound_order_no IS NULL OR inbound_order_no = '')`
  },
  {
    id: 'IN-TOTAL-MISMATCH',
    level: 'YELLOW',
    title: '入库明细 小计 ≠ 数量 × 单价',
    why: '金额算错会影响成本和利润。容差 0.01（四舍五入）以内算正常。'
      + '⚠️ 待补价明细（unit_price 为 NULL）不参与此判据 —— 它的 total_price 就该是 0，'
      + '显式排除而不是靠 NULL 传播绕过去，否则判据本身说不清自己的口径',
    count: `SELECT COUNT(*) AS n FROM inbound_order_items
             WHERE quantity > 0
               AND price_pending = 0
               AND unit_price IS NOT NULL
               AND ABS(total_price - quantity * unit_price) > 0.01`,
    sample: `SELECT id, order_id, material_name, quantity, unit_price, total_price,
                   ROUND(quantity * unit_price, 2) AS 应为
              FROM inbound_order_items
             WHERE quantity > 0
               AND price_pending = 0
               AND unit_price IS NOT NULL
               AND ABS(total_price - quantity * unit_price) > 0.01`
  },
  {
    // 2026-10-20 新增（配合「待补价」上线）
    // 为什么要有：「待补价」把「单价未定」和「单价为 0」分成了两种状态，
    //   一旦标记和金额不自洽（标了待补价却有金额 / 没标待补价却缺单价），
    //   成本核算会把它当 0 参与加权 → 悄悄稀释成本，事后极难发现。
    id: 'IN-PENDING-INCONSISTENT',
    level: 'ORANGE',
    title: '待补价明细的标记与金额不自洽',
    why: '「待补价」= 单价还没定，此时 total_price 必须是 0、unit_price 必须是空。'
      + '反过来，没标待补价的明细必须有单价。不自洽会让成本核算把「未定价」当成 0 参与加权，'
      + '把已有成本永久稀释且不可逆',
    count: `SELECT COUNT(*) AS n FROM inbound_order_items
             WHERE (price_pending = 1 AND (unit_price IS NOT NULL OR total_price <> 0))
                OR (price_pending = 0 AND unit_price IS NULL)`,
    sample: `SELECT id, order_id, material_name, quantity, unit_price, price_pending, total_price,
                   CASE WHEN price_pending = 1 AND unit_price IS NOT NULL THEN '标了待补价却有单价'
                        WHEN price_pending = 1 AND total_price <> 0     THEN '标了待补价却有金额'
                        ELSE '没标待补价却缺单价' END AS 问题
              FROM inbound_order_items
             WHERE (price_pending = 1 AND (unit_price IS NOT NULL OR total_price <> 0))
                OR (price_pending = 0 AND unit_price IS NULL)`
  },
  {
    // 2026-10-20 新增：列表页靠 pending_count 打「待补价」标签，数不对会出现
    //   「单子上写着待补价、点进去没有」或反过来「有待补价却查不到」。
    id: 'IN-PENDING-COUNT',
    level: 'YELLOW',
    title: '入库单 pending_count 与明细实际待补数不符',
    why: '列表页与看板靠这个冗余字段标「金额未定稿」。数不对 → 该补价的单没人看见，'
      + '或补完了还一直挂着红标',
    count: `SELECT COUNT(*) AS n FROM inbound_orders o
             WHERE o.pending_count <> (
               SELECT COUNT(*) FROM inbound_order_items i
                WHERE i.order_id = o.id AND i.price_pending = 1
             )`,
    sample: `SELECT o.id, o.order_no, o.status, o.pending_count AS 记的数,
                   (SELECT COUNT(*) FROM inbound_order_items i
                     WHERE i.order_id = o.id AND i.price_pending = 1) AS 实际数
              FROM inbound_orders o
             WHERE o.pending_count <> (
               SELECT COUNT(*) FROM inbound_order_items i
                WHERE i.order_id = o.id AND i.price_pending = 1
             )`
  },

  // ---------------- 明细重复 / 数量值域 ----------------
  {
    id: 'DUP-ITEM',
    level: 'ORANGE',
    title: '同一单据里同一物料出现多条明细',
    why: '前端展示会重复，汇总数量可能重复计算；出库/盘点时尤其危险',
    count: `SELECT (
      (SELECT COUNT(*) FROM (SELECT order_id, material_id FROM outbound_order_items GROUP BY order_id, material_id HAVING COUNT(*) > 1) t1)
    + (SELECT COUNT(*) FROM (SELECT order_id, material_id FROM inbound_order_items  GROUP BY order_id, material_id HAVING COUNT(*) > 1) t2)
    + (SELECT COUNT(*) FROM (SELECT task_id,  material_id FROM purchase_task_items  GROUP BY task_id,  material_id HAVING COUNT(*) > 1) t3)
    ) AS n`,
    sample: `SELECT '出库' AS 来源, order_id AS 单id, material_id, COUNT(*) AS 重复条数 FROM outbound_order_items GROUP BY order_id, material_id HAVING COUNT(*) > 1
      UNION ALL SELECT '入库', order_id, material_id, COUNT(*) FROM inbound_order_items GROUP BY order_id, material_id HAVING COUNT(*) > 1
      UNION ALL SELECT '采购', task_id, material_id, COUNT(*) FROM purchase_task_items GROUP BY task_id, material_id HAVING COUNT(*) > 1`
  },
  {
    id: 'QTY-NOT-POSITIVE',
    level: 'RED',
    title: '单据明细数量为 0 或负数',
    why: '数量 0 的明细没有意义；负数更会反向改库存。两者都不该由正常流程产生',
    count: `SELECT (
      (SELECT COUNT(*) FROM outbound_order_items WHERE quantity <= 0)
    + (SELECT COUNT(*) FROM inbound_order_items  WHERE quantity <= 0)
    + (SELECT COUNT(*) FROM purchase_task_items  WHERE quantity <= 0)
    ) AS n`,
    sample: `SELECT '出库' AS 来源, id, material_name, quantity FROM outbound_order_items WHERE quantity <= 0
      UNION ALL SELECT '入库', id, material_name, quantity FROM inbound_order_items WHERE quantity <= 0
      UNION ALL SELECT '采购', id, material_name, quantity FROM purchase_task_items WHERE quantity <= 0`
  },

  // ---------------- 时间 / 边界 ----------------
  {
    id: 'TIME-INCONSISTENT',
    level: 'YELLOW',
    title: '时间列前后矛盾',
    why: '例如「收货时间」早于「创建时间」。会让月结/报表按时间统计时算错区间',
    count: `SELECT (
      (SELECT COUNT(*) FROM outbound_orders WHERE received_at IS NOT NULL AND received_at < created_at)
    + (SELECT COUNT(*) FROM inbound_orders  WHERE confirmed_at IS NOT NULL AND confirmed_at < created_at)
    + (SELECT COUNT(*) FROM purchase_tasks  WHERE received_at IS NOT NULL AND received_at < created_at)
    + (SELECT COUNT(*) FROM users           WHERE last_login_at IS NOT NULL AND last_login_at > NOW())
    ) AS n`,
    sample: `SELECT '出库单' AS 来源, id, created_at, received_at AS 异常时间 FROM outbound_orders WHERE received_at IS NOT NULL AND received_at < created_at
      UNION ALL SELECT '入库单', id, created_at, confirmed_at FROM inbound_orders WHERE confirmed_at IS NOT NULL AND confirmed_at < created_at
      UNION ALL SELECT '采购单', id, created_at, received_at FROM purchase_tasks WHERE received_at IS NOT NULL AND received_at < created_at`
  },
  {
    id: 'NEAR-LIMIT',
    level: 'YELLOW',
    title: '字段值已贴着列长上限（≥95%）',
    why: '现在能存，下一次追加几个字就会被截断或报错（历史踩过字段长度陷阱）',
    count: `SELECT (
      (SELECT COUNT(*) FROM materials WHERE CHAR_LENGTH(name) >= 182)
    + (SELECT COUNT(*) FROM materials WHERE CHAR_LENGTH(spec) >= 182)
    + (SELECT COUNT(*) FROM materials WHERE CHAR_LENGTH(remark) >= 243)
    + (SELECT COUNT(*) FROM suppliers WHERE CHAR_LENGTH(address) >= 243)
    + (SELECT COUNT(*) FROM suppliers WHERE CHAR_LENGTH(name) >= 122)
    + (SELECT COUNT(*) FROM outbound_orders WHERE CHAR_LENGTH(remark) >= 243)
    + (SELECT COUNT(*) FROM operation_logs WHERE CHAR_LENGTH(detail) >= 487)
    + (SELECT COUNT(*) FROM messages WHERE CHAR_LENGTH(content) >= 487)
    ) AS n`,
    sample: `SELECT '物料名' AS 字段, id, CHAR_LENGTH(name) AS 当前长度, 191 AS 上限 FROM materials WHERE CHAR_LENGTH(name) >= 182
      UNION ALL SELECT '物料规格', id, CHAR_LENGTH(spec), 191 FROM materials WHERE CHAR_LENGTH(spec) >= 182
      UNION ALL SELECT '物料备注', id, CHAR_LENGTH(remark), 255 FROM materials WHERE CHAR_LENGTH(remark) >= 243
      UNION ALL SELECT '出库备注', id, CHAR_LENGTH(remark), 255 FROM outbound_orders WHERE CHAR_LENGTH(remark) >= 243`
  },
  {
    id: 'MSG-BACKLOG',
    level: 'YELLOW',
    title: '大量未读消息堆积（可能没人真的收到）',
    why: '按人投递的消息若收件人身份对不上，就永远没人读 —— 与「消息已读 401」那次同源',
    count: `SELECT COUNT(*) AS n FROM messages WHERE is_read = 0`,
    sample: `SELECT m.to_openid AS 收件人, COUNT(*) AS 未读数
              FROM messages m WHERE m.is_read = 0
             GROUP BY m.to_openid ORDER BY COUNT(*) DESC`
  },
  {
    id: 'MSG-ORPHAN-RECIPIENT',
    level: 'ORANGE',
    title: '消息的收件人身份在用户表里找不到',
    why: '这条消息谁都看不到（静默丢失）。收件人键应为 COALESCE(openid, username)',
    count: `SELECT COUNT(*) AS n FROM messages m
             WHERE m.is_read = 0
               AND NOT EXISTS (
                 SELECT 1 FROM users u
                  WHERE u.status = 'active'
                    AND (u.openid = m.to_openid OR u.username = m.to_openid)
               )`,
    sample: `SELECT m.to_openid AS 收件人, COUNT(*) AS 条数, MIN(m.created_at) AS 最早, MAX(m.created_at) AS 最晚
              FROM messages m
             WHERE m.is_read = 0
               AND NOT EXISTS (SELECT 1 FROM users u WHERE u.status='active' AND (u.openid = m.to_openid OR u.username = m.to_openid))
             GROUP BY m.to_openid`
  }
]

async function run() {
  const results = []
  for (const c of CHECKS) {
    const item = { id: c.id, level: c.level, title: c.title, why: c.why }
    try {
      if (typeof c.js === 'function') {
        const r = await c.js()
        item.count = Number(r.count || 0)
        item.rows = r.rows || []
      } else {
        item.count = await count(c.count)
        item.rows = item.count > 0 && c.sample ? await sample(c.sample, 3) : []
      }
      item.ok = item.count === 0
    } catch (e) {
      item.ok = false
      item.error = (e && e.message) || String(e)
    }
    results.push(item)
  }
  return results
}

function fmtRows(rows) {
  return (rows || []).map((r) => {
    const parts = Object.entries(r).map(([k, v]) => `${k}=${v === null ? 'NULL' : v}`)
    return `        · ${parts.join('  ')}`
  })
}

async function main() {
  const asJson = process.argv.includes('--json')
  const showAll = process.argv.includes('--all')
  const only = process.env.LEVEL

  let dbName = '?'
  try {
    const [r] = await pool.query('SELECT DATABASE() AS d')
    dbName = r[0].d
  } catch (e) {
    console.error('❌ 连不上数据库：', (e && e.message) || e)
    process.exit(2)
  }

  let results
  try {
    results = await run()
  } catch (e) {
    console.error('❌ 扫描自身故障：', (e && e.stack) || e)
    await pool.end()
    process.exit(2)
  }

  const errors = results.filter((r) => r.error)
  const hits = results.filter((r) => !r.error && r.count > 0)
  const reds = hits.filter((r) => r.level === 'RED')
  const scoped = only ? results.filter((r) => r.level === only) : results

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          at: new Date().toISOString(),
          db: dbName,
          total: results.length,
          red: reds.length,
          hits: hits.length,
          errors: errors.length,
          results: scoped
        },
        null,
        2
      )
    )
    await pool.end()
    process.exit(reds.length || errors.length ? 1 : 0)
  }

  console.log(BAR)
  console.log('  生产隐患扫描  scan-hazards')
  console.log(`  时间：${new Date().toLocaleString('zh-CN')}`)
  console.log(`  目标库：${dbName}   ·   检查项：${results.length} 项   ·   全部只读`)
  console.log(BAR)
  console.log('')

  let printed = 0
  for (const lv of LEVEL_ORDER) {
    if (only && only !== lv) continue
    const list = results.filter((r) => r.level === lv)
    const bad = list.filter((r) => r.error || r.count > 0)
    const meta = LEVELS[lv]

    if (!bad.length && !showAll) continue

    console.log(`${meta.icon} ${meta.name}（${meta.hint}）`)
    console.log('')
    if (!bad.length) {
      console.log(`   全部通过（${list.length} 项）`)
      console.log('')
      continue
    }
    bad.forEach((r, i) => {
      printed++
      if (r.error) {
        console.log(`   ${i + 1}. [${r.id}] ${r.title}`)
        console.log(`      ⚠️ 检查本身执行失败：${r.error}`)
        console.log('')
        return
      }
      console.log(`   ${i + 1}. [${r.id}] ${r.title}  ——  ${r.count} 条`)
      console.log(`      后果：${String(r.why).replace(/\n\s*/g, ' ')}`)
      fmtRows(r.rows).forEach((line) => console.log(line))
      console.log('')
    })
  }

  if (!printed) {
    console.log('✅ 全部检查项均未发现异常\n')
  }

  const passed = results.filter((r) => !r.error && r.count === 0).length
  console.log(BAR)
  console.log(`  有问题的检查项：${hits.length} / ${results.length}（通过 ${passed} 项）`)
  if (reds.length) {
    console.log(`  ${LEVELS.RED.icon} 严重项 ${reds.length} 个：${reds.map((r) => r.id).join('、')}`)
  }
  if (errors.length) console.log(`  💥 扫描失败的检查项 ${errors.length} 个：${errors.map((r) => r.id).join('、')}`)
  if (!reds.length && !errors.length) console.log('  ✅ 没有严重隐患')
  console.log(BAR)

  await pool.end()
  process.exit(reds.length || errors.length ? 1 : 0)
}

module.exports = { run, CHECKS }

if (require.main === module) {
  main().catch(async (e) => {
    console.error('\n❌ scan-hazards 自身失败：', (e && e.stack) || e)
    try {
      await pool.end()
    } catch (_) {
      /* 忽略 */
    }
    process.exit(2)
  })
}
