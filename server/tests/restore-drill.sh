#!/bin/bash
# 恢复演练：拿刚生成的备份导进一个临时库，核对表数与关键表行数，然后删掉临时库。
# 目的：证明「备份文件真能还原出完整数据」，而不是只生成了一个文件。
#
# 用法（必须以 root 跑，走 MySQL 的 auth_socket 免密）：
#   sudo bash tests/restore-drill.sh
#
# 安全：
#   · 只在库名以 _restore_probe 结尾时才 DROP，杜绝误删生产库
#   · 临时库用完即删，不留痕迹
set -euo pipefail

[ "$(id -u)" = "0" ] || { echo "✗ 请用 sudo 运行（需要 MySQL 管理员权限）"; exit 1; }

set -a
. /opt/shenglong/server/.env
set +a

PROBE_DB=shenglong_restore_probe
case "$PROBE_DB" in
  *_restore_probe) : ;;
  *) echo "✗ 安全闸门：库名必须以 _restore_probe 结尾"; exit 1 ;;
esac

# 管理操作走本机 root（auth_socket 免密）；这里 mysql 不带 -u 即用当前 OS 用户
MYSQL_ADMIN="mysql"

BACKUP="$(ls -1t /var/backups/shenglong-mysql/shenglong-*.sql.gz | head -1)"
echo "使用备份：$BACKUP ($(du -h "$BACKUP" | cut -f1))"

echo
echo "=== 1) 建临时库 ==="
$MYSQL_ADMIN -e "DROP DATABASE IF EXISTS \`$PROBE_DB\`; CREATE DATABASE \`$PROBE_DB\` DEFAULT CHARACTER SET utf8mb4;"
echo "已建 $PROBE_DB（同名残留会先删掉）"

echo
echo "=== 2) 导入备份 ==="
$MYSQL_ADMIN "$PROBE_DB" < <(gzip -dc "$BACKUP")
echo "导入完成"

echo
echo "=== 3) 对比：生产库 vs 恢复库（关键表行数）==="
printf "%-22s %10s %10s  %s\n" "表名" "生产" "恢复" "一致"
printf "%-22s %10s %10s  %s\n" "----------------------" "----------" "----------" "----"
MISMATCH=0
for t in users materials warehouses inbound_orders outbound_orders stock_logs messages purchase_tasks; do
  A=$($MYSQL_ADMIN -N -B -e "SELECT COUNT(*) FROM \`$DB_NAME\`.\`$t\`" 2>/dev/null || echo "N/A")
  B=$($MYSQL_ADMIN -N -B -e "SELECT COUNT(*) FROM \`$PROBE_DB\`.\`$t\`" 2>/dev/null || echo "N/A")
  if [ "$A" = "$B" ]; then MARK="✓"; else MARK="✗ 不一致"; MISMATCH=1; fi
  printf "%-22s %10s %10s  %s\n" "$t" "$A" "$B" "$MARK"
done

echo
echo "=== 4) 表数量 ==="
TA=$($MYSQL_ADMIN -N -B -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB_NAME'")
TB=$($MYSQL_ADMIN -N -B -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$PROBE_DB'")
echo "生产 $TA 张 / 恢复 $TB 张"

echo
echo "=== 5) 清理临时库 ==="
$MYSQL_ADMIN -e "DROP DATABASE \`$PROBE_DB\`;"
LEFT=$($MYSQL_ADMIN -N -B -e "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='$PROBE_DB'")
echo "临时库已删除（残留 $LEFT 个）"

echo
if [ "$TA" = "$TB" ] && [ "$MISMATCH" = "0" ] && [ "$LEFT" = "0" ]; then
  echo "✅ 恢复演练通过：备份可完整还原 $TB 张表，关键表行数全部一致"
else
  echo "⚠️ 演练未通过（表数 生产$TA/恢复$TB，行数不一致=$MISMATCH，残留=$LEFT）"
  exit 1
fi
