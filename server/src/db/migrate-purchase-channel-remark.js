/**
 * 迁移：purchase_task_items 加「其他购买方式的说明」一列
 * 背景（2026-10-09）：购买方式从「淘宝/京东/线下/其他」扩到
 *   淘宝 / 京东 / 1688 / 拼多多 / 线下 / 其他。
 *   选「其他」时只留一个「其他」查不出货是从哪买的，所以要求必须写一句说明。
 * 幂等：已存在则跳过。
 * 安全性：纯 ADD COLUMN（NOT NULL DEFAULT ''），不动既有数据，无需备份表
 *   （⚠️ 若以后改成 UPDATE 回填历史数据，必须先 CREATE TABLE _bak_<stamp>_... AS SELECT *）。
 */
require('../../src/config/env')
const { queryOne, execute } = require('../../src/db/pool')

async function hasCol(name) {
  const r = await queryOne(
    `SELECT COUNT(*) c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_task_items' AND COLUMN_NAME = ?`,
    [name]
  )
  return Number(r.c) > 0
}

async function main() {
  if (!(await hasCol('channel_remark'))) {
    await execute(
      `ALTER TABLE purchase_task_items
         ADD COLUMN channel_remark VARCHAR(255) NOT NULL DEFAULT ''
         COMMENT '购买方式选「其他」时的说明（必填）' AFTER purchase_channel`
    )
    console.log('+ channel_remark')
  } else {
    console.log('= channel_remark 已存在，跳过')
  }

  // 把列注释里过时的枚举也一并更新（老注释只写了 淘宝/京东/线下/其他）
  await execute(
    `ALTER TABLE purchase_task_items
       MODIFY COLUMN purchase_channel VARCHAR(32) NOT NULL DEFAULT ''
       COMMENT '该项购买方式（淘宝/京东/1688/拼多多/线下/其他）'`
  )
  console.log('~ purchase_channel 注释已更新')

  // ⚠️ 必须加宽：任务级 purchase_channel 存的是各项渠道去重后的拼接串
  //    （「淘宝 / 京东 / 1688 / 拼多多 / 线下 / 其他」已经 30 字），
  //    现在还要带上「其他」的说明，32 字装不下。
  //    本机 MySQL 开了 STRICT_TRANS_TABLES → 超长不是截断而是报 1406 直接提交失败。
  const wide = await queryOne(
    `SELECT COLUMN_TYPE t FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_tasks'
        AND COLUMN_NAME = 'purchase_channel'`
  )
  const wideLen = Number((String(wide && wide.t).match(/\d+/) || [0])[0])
  if (wideLen > 0 && wideLen < 128) {
    await execute(
      `ALTER TABLE purchase_tasks
         MODIFY COLUMN purchase_channel VARCHAR(128) NOT NULL DEFAULT ''
         COMMENT '购买方式（各项去重拼接，如「淘宝 / 线下」）'`
    )
    console.log('~ purchase_tasks.purchase_channel 加宽到 128')
  }

  // external_no 同理：整单存的是各项外部单号去重拼接，多个单号一拼就超 64
  const wideExt = await queryOne(
    `SELECT COLUMN_TYPE t FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_tasks'
        AND COLUMN_NAME = 'external_no'`
  )
  if (wideExt && Number((wideExt.t.match(/\d+/) || [0])[0]) < 255) {
    await execute(
      `ALTER TABLE purchase_tasks
         MODIFY COLUMN external_no VARCHAR(255) NOT NULL DEFAULT ''
         COMMENT '外部单号（各项去重拼接）'`
    )
    console.log('~ purchase_tasks.external_no 加宽到 255')
  }

  console.log('迁移完成')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
