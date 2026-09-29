#!/bin/bash
# ============================================
# 胜龙进销存 · 数据库每日自动备份
# 由 docker-compose 的 backup 服务调用
# ============================================
set -u

DB_HOST="${DB_HOST:-mysql}"
DB_NAME="${DB_NAME:-shenglong}"
DB_USER="${DB_USER:-root}"
DB_PASSWORD="${DB_PASSWORD:-rootpass}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
BACKUP_DIR="/backup"

mkdir -p "$BACKUP_DIR"

echo "[备份服务] 已启动，每天 03:00 自动备份到 ${BACKUP_DIR}，保留 ${BACKUP_KEEP_DAYS} 天"

# 等待数据库就绪
sleep 15

while true; do
  NOW_HHMM=$(date +%H%M)
  if [ "$NOW_HHMM" = "0300" ]; then
    STAMP=$(date +%Y%m%d_%H%M%S)
    FILE="${BACKUP_DIR}/${DB_NAME}_${STAMP}.sql"

    echo "[$(date '+%F %T')] 开始备份 -> ${FILE}"

    if mysqldump -h"$DB_HOST" -u"$DB_USER" -p"$DB_PASSWORD" \
        --single-transaction --routines --triggers --default-character-set=utf8mb4 \
        "$DB_NAME" > "$FILE" 2>"${BACKUP_DIR}/last_error.log"; then

      gzip -f "$FILE"
      SIZE=$(du -h "${FILE}.gz" | cut -f1)
      echo "[$(date '+%F %T')] 备份完成：${FILE}.gz (${SIZE})"

      # 清理过期备份
      find "$BACKUP_DIR" -name "${DB_NAME}_*.sql.gz" -mtime +"$BACKUP_KEEP_DAYS" -delete
      echo "[$(date '+%F %T')] 已清理 ${BACKUP_KEEP_DAYS} 天前的备份"
    else
      echo "[$(date '+%F %T')] 备份失败，详见 ${BACKUP_DIR}/last_error.log"
    fi

    # 跳过当天剩余时间
    sleep 60
  fi

  sleep 30
done
