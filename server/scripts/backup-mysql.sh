#!/usr/bin/env bash
#
# 胜龙进销存 · 生产数据库每日备份
#
# 背景：服务器上原本的 shenglong-backup.timer 备份的是**上一代系统的 SQLite 库**
#      （/home/ubuntu/lingliao/data.db），与本项目 MySQL 库无关 ——
#      也就是说本项目上线后一直没有自动备份。这个脚本补上这一环。
#
# 用法：
#   /opt/shenglong/backup-mysql.sh          # 手动跑一次
#   systemctl start shenglong-mysql-backup  # 跑一次（systemd）
#   定时由 shenglong-mysql-backup.timer 负责（每日 03:40）
#
# 设计要点：
#   · --single-transaction：InnoDB 一致性快照，不锁表、不打断业务
#   · MYSQL_PWD 传密码：避免密码出现在 ps 的命令行里
#   · 三重校验（文件大小 / 能解压 / 含 CREATE TABLE）后才算成功 —— 空文件不算备份
#   · 只清理本目录里自己生成的 shenglong-*.sql.gz，绝不动别的文件

set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/shenglong/server/.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/shenglong-mysql}"
KEEP_DAYS="${KEEP_DAYS:-30}"

log() { echo "[$(date '+%F %T')] $*"; }

[ -r "$ENV_FILE" ] || { log "✗ 读不到环境文件：$ENV_FILE"; exit 1; }

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

: "${DB_HOST:?DB_HOST 未配置}"
: "${DB_USER:?DB_USER 未配置}"
: "${DB_PASSWORD:?DB_PASSWORD 未配置}"
: "${DB_NAME:?DB_NAME 未配置}"
DB_PORT="${DB_PORT:-3306}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/shenglong-$STAMP.sql.gz"
TMP="$OUT.part"
ERR="$(mktemp /tmp/shenglong-dump-err.XXXXXX)"

cleanup() { [ -f "$TMP" ] && rm -f "$TMP" || true; rm -f "$ERR"; }
trap cleanup EXIT

log "开始备份 库=$DB_NAME 主机=$DB_HOST:$DB_PORT → $OUT"

# --no-tablespaces：MySQL 8 的 mysqldump 默认要读 information_schema.files 导表空间，
#   那需要 PROCESS 权限，而业务账号 shenglong 没有（报 Access denied ... dump tablespaces）。
#   不导表空间对数据恢复无影响，且不必为此扩大业务账号权限。
if ! MYSQL_PWD="$DB_PASSWORD" mysqldump \
  --single-transaction --quick --routines --events --no-tablespaces \
  --default-character-set=utf8mb4 \
  -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" \
  "$DB_NAME" 2>"$ERR" | gzip -9 > "$TMP"; then
  log "✗ mysqldump 执行失败，错误如下："
  sed 's/^/    /' "$ERR"
  exit 1
fi

if [ -s "$ERR" ]; then
  log "（mysqldump 有告警，仅供参考）"
  sed 's/^/    /' "$ERR"
fi

# ---- 校验 1：文件大小 ----
SIZE="$(stat -c%s "$TMP")"
if [ "$SIZE" -lt 10240 ]; then
  log "✗ 备份文件仅 ${SIZE}B，明显异常，判定失败"
  exit 1
fi

# ---- 校验 2：能正常解压 ----
if ! gzip -t "$TMP" 2>/dev/null; then
  log "✗ 备份文件解压校验不通过，判定失败"
  exit 1
fi

# ---- 校验 3：内容含建表语句 ----
# ⚠️ 这里必须用 grep -c（读完全部输入），不能用 grep -q：
#   本脚本开了 set -o pipefail，而 grep -q 一旦匹配就立刻退出，
#    上游 gzip 随即收到 SIGPIPE → 整条管道被判非 0 → 误报「不含建表语句」。
TABLES="$(gzip -dc "$TMP" | grep -c 'CREATE TABLE' || true)"
if [ "${TABLES:-0}" -lt 1 ]; then
  log "✗ 备份内容不含任何建表语句（解出 ${TABLES:-0} 张），判定失败"
  exit 1
fi

mv "$TMP" "$OUT"
log "✓ 备份成功：$(du -h "$OUT" | cut -f1) / 含 $TABLES 张表"

# ---- 清理过期备份（仅限本目录自有文件） ----
DELETED="$(find "$BACKUP_DIR" -maxdepth 1 -name 'shenglong-*.sql.gz' -type f -mtime "+$KEEP_DAYS" -print -delete | wc -l)"
[ "$DELETED" -gt 0 ] && log "已清理 $DELETED 份超过 ${KEEP_DAYS} 天的旧备份"

KEPT="$(find "$BACKUP_DIR" -maxdepth 1 -name 'shenglong-*.sql.gz' -type f | wc -l)"
log "当前保留 $KEPT 份备份（保留 ${KEEP_DAYS} 天）"
