#!/usr/bin/env bash
# ===========================================================================
#  运维与暴露面隐患排查（只读，不修改任何东西）
#
#  为什么单独有这个脚本：
#    功能测试和结构对撞都只看「代码对不对」，看不出「环境会不会迟早出事」。
#    2026-10-16 生产排查发现的这几类问题，没有一个是功能测试能发现的：
#      · 登录接口零限流（密码可无限猜）    → 探不到，因为功能"正常"
#      · 没有任何安全响应头               → 探不到，因为页面照样打开
#      · nginx 用 $proxy_add_x_forwarded_for → 客户端可伪造来源 IP
#      · journald 无容量上限（已 608MB）  → 探不到，因为磁盘还没满
#      · 备份定时器装好后从未触发过        → 探不到，因为备份文件"存在"
#
#  用法：  bash server/scripts/scan-ops.sh
#  前置：  能 ssh 到生产（默认密钥 ~/.ssh/id_ed25519_sljxc）
#  退出码：0 = 无 FAIL；1 = 有 FAIL
#
#  ⚠️ 全部只读：不重启服务、不改配置、不写数据库。
#     唯一例外是 /tmp 下写两个临时文件，退出时自动删除。
# ===========================================================================
set -uo pipefail

SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_sljxc}"
SSH_TARGET="${SSH_TARGET:-ubuntu@119.91.206.235}"
SITE="${SITE:-https://sl.ekkosys.cn}"
SERVER_DIR="/opt/shenglong/server"
BACKUP_DIR="/var/backups/shenglong-mysql"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0; WARN=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  ✅ $1"; }
warn() { WARN=$((WARN+1)); echo "  ⚠️  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ❌ $1"; }

SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=15 -n $SSH_TARGET"

echo "=============================================="
echo "  运维与暴露面隐患排查（只读）"
echo "  站点：$SITE"
echo "  主机：$SSH_TARGET"
echo "=============================================="
echo

# ---------------------------------------------------------------- 1. 安全响应头
echo "【1】安全响应头（防点击劫持 / 内容嗅探 / 降级）"
HDRS="$(curl -sI -m 12 "$SITE/api/health" 2>/dev/null | tr -d '\r')"
for h in "X-Content-Type-Options" "X-Frame-Options" "Referrer-Policy" "Strict-Transport-Security"; do
  if echo "$HDRS" | grep -qi "^$h:"; then pass "$h 已设置"
  else bad "$h 缺失"; fi
done
if echo "$HDRS" | grep -qi "^X-Powered-By:"; then warn "X-Powered-By 暴露了技术栈（建议移除）"
else pass "未暴露 X-Powered-By"; fi
echo

# ---------------------------------------------------------------- 2. 敏感路径
echo "【2】敏感文件是否可被直接下载（200/206 = 危险）"
for p in "/.env" "/server/.env" "/server/src/app.js" "/.git/config" "/package.json" \
         "/uploads/../server/.env" "/uploads/%2e%2e/server/.env"; do
  C="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$SITE$p" 2>/dev/null)"
  case "$C" in
    200|206) bad "可下载：$p → $C" ;;
    *)       pass "不可下载：$p → $C" ;;
  esac
done
echo

# ---------------------------------------------------------------- 3. 证书
echo "【3】HTTPS 证书有效期"
END="$(echo | openssl s_client -connect "${SITE#https://}:443" -servername "${SITE#https://}" 2>/dev/null \
       | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
if [ -n "$END" ]; then
  ENDS="$(date -d "$END" +%s 2>/dev/null || echo 0)"
  DAYS=$(( (ENDS - $(date +%s)) / 86400 ))
  if [ "$DAYS" -gt 21 ]; then pass "证书还有 ${DAYS} 天到期（$END）"
  elif [ "$DAYS" -gt 7 ]; then warn "证书仅剩 ${DAYS} 天（$END），确认 certbot 自动续期在跑"
  else bad "证书仅剩 ${DAYS} 天，即将过期！"; fi
else
  warn "无法读取证书到期时间"
fi
echo

# ---------------------------------------------------------------- 4. 端口暴露
echo "【4】服务监听地址（只应监听 127.0.0.1，公网由 nginx 终结）"
LISTEN="$($SSH 'sudo ss -ltn 2>/dev/null | awk "{print \$4}"' 2>/dev/null)"
for port in 3000 3306; do
  if echo "$LISTEN" | grep -qE "(^|:)$port$"; then
    if echo "$LISTEN" | grep -qE "0\.0\.0\.0:$port|\[::\]:$port"; then
      bad "$port 监听在 0.0.0.0（对公网开放）"
    else
      pass "$port 仅监听本机"
    fi
  else
    warn "$port 未在监听（服务是否在跑？）"
  fi
done
echo

# ---------------------------------------------------------------- 5. XFF 可伪造
echo "【5】nginx 转发来源 IP 是否可被客户端伪造"
NGX="$($SSH 'sudo nginx -T 2>/dev/null | grep -h "X-Forwarded-For"' 2>/dev/null | head -3)"
if echo "$NGX" | grep -q 'proxy_add_x_forwarded_for'; then
  bad "用了 \$proxy_add_x_forwarded_for → 客户端自带 XFF 会被保留，按 IP 限流可被绕过"
elif echo "$NGX" | grep -q 'X-Forwarded-For \$remote_addr'; then
  pass "使用 \$remote_addr（覆盖式，来源 IP 可信）"
else
  warn "未能识别 XFF 配置：$NGX"
fi
echo

# ------------------------------------------------- 5b. 会被误加载的 nginx 文件
# 为什么单独查这个（2026-10-16 踩到的真坑）：
#   nginx.conf 用 `include /etc/nginx/sites-enabled/*` —— 通配符会把该目录下
#   **任何文件**都当配置加载。把配置备份放在这里，备份就成了「第二份生效配置」，
#   造成 server_name 冲突，且改动看起来"不生效"（实际是另一份老配置在抢）。
#   备份必须放到 include 范围之外（本机是 /etc/nginx/backups-ekko/）。
echo "【5b】nginx 配置目录是否混入了会被误加载的备份/临时文件"
# 只按「备份/临时」命名特征判定 —— Debian 下 sites-enabled 里的有效配置本来就
# 可能不带 .conf 后缀（如 sl.ekkosys.cn），按「非 .conf」筛会误报。
STRAY="$($SSH 'sudo find /etc/nginx/sites-enabled /etc/nginx/conf.d -maxdepth 1 -type f \( -name "*.bak*" -o -name "*~" -o -name "*.old" -o -name "*.save*" -o -name "*.orig" -o -name "*.dpkg-*" -o -name "*.tmp" -o -name "*.swp" -o -name "*.disabled" \) 2>/dev/null' 2>/dev/null)"
if [ -n "$STRAY" ]; then
  bad "sites-enabled/conf.d 里有备份/临时文件，会被 nginx 当配置加载（备份请放到 include 范围外，如 /etc/nginx/backups-ekko/）："
  echo "$STRAY" | sed 's/^/       /'
else
  pass "没有备份/临时文件混入配置目录"
fi
NGXWARN="$($SSH 'sudo nginx -t 2>&1 | grep -i "conflicting server name"' 2>/dev/null)"
if [ -n "$NGXWARN" ]; then
  bad "nginx 报 server name 冲突（说明同一域名被定义了多次，行为不可预期）："
  echo "$NGXWARN" | sed 's/^/       /'
else
  pass "nginx -t 无 server name 冲突"
fi
echo

# ---------------------------------------------------------------- 6. 服务守护
echo "【6】后端服务守护与运行身份"
UNIT="$($SSH 'systemctl cat shenglong-api 2>/dev/null' 2>/dev/null)"
if echo "$UNIT" | grep -qi "^Restart="; then
  pass "已配置 Restart（$($SSH 'systemctl cat shenglong-api 2>/dev/null | grep -i "^Restart=" | head -1' 2>/dev/null)）"
else
  warn "未显式配置 Restart=always → 进程崩溃后不会自愈（systemd 默认 no）"
fi
ACTC="$($SSH 'systemctl is-active shenglong-api' 2>/dev/null)"
[ "$ACTC" = "active" ] && pass "服务状态：active" || bad "服务状态：$ACTC"
echo

# ---------------------------------------------------------------- 7. 日志与磁盘
echo "【7】日志容量与磁盘余量"
JCAP="$($SSH 'grep -E "^SystemMaxUse=" /etc/systemd/journald.conf 2>/dev/null' 2>/dev/null)"
[ -n "$JCAP" ] && pass "journald 已设上限：$JCAP" || bad "journald 未设 SystemMaxUse（日志会无限增长直到写满磁盘）"
USED="$($SSH 'journalctl --disk-usage 2>/dev/null' 2>/dev/null)"
DISK="$(echo "$USED" | grep -oE '[0-9.]+M' | head -1)"
echo "     journal 当前占用：${DISK:-未知}"
DPCT="$($SSH 'df / | tail -1 | awk "{print \$5}"' 2>/dev/null | tr -d '%')"
if [ -n "$DPCT" ]; then
  if [ "$DPCT" -lt 80 ]; then pass "根分区已用 ${DPCT}%"
  elif [ "$DPCT" -lt 90 ]; then warn "根分区已用 ${DPCT}%"
  else bad "根分区已用 ${DPCT}%，随时可能写满"; fi
fi
echo

# ---------------------------------------------------------------- 8. 备份可用性
echo "【8】数据库备份：最近一份是否存在、是否完整"
LATEST="$($SSH "sudo ls -t $BACKUP_DIR/shenglong-*.sql.gz 2>/dev/null | head -1" 2>/dev/null)"
if [ -z "$LATEST" ]; then
  bad "找不到任何备份文件"
else
  AGE_H=$($SSH "echo \$(( ( \$(date +%s) - \$(stat -c %Y '$LATEST') ) / 3600 ))" 2>/dev/null)
  SIZE="$($SSH "sudo du -h '$LATEST' | cut -f1" 2>/dev/null)"
  if [ "${AGE_H:-999}" -lt 30 ]; then pass "最近备份：$(basename "$LATEST")（${SIZE}，${AGE_H} 小时前）"
  else warn "最近备份已 ${AGE_H} 小时前：$(basename "$LATEST")"; fi
  # 完整性：gzip 校验 + 是否含建表语句
  if $SSH "sudo gzip -t '$LATEST' 2>/dev/null" 2>/dev/null; then
    TBL=$($SSH "sudo gzip -dc '$LATEST' 2>/dev/null | grep -c 'CREATE TABLE'" 2>/dev/null)
    if [ "${TBL:-0}" -gt 5 ]; then pass "备份完整：gzip 校验通过，含 $TBL 张建表语句"
    else bad "备份内容可疑：只含 ${TBL:-0} 张建表语句"; fi
  else
    bad "备份文件已损坏：gzip 校验失败"
  fi
fi
echo

# ---------------------------------------------------------------- 9. 定时器
echo "【9】备份定时器是否真的按期触发过"
NEXT="$($SSH 'systemctl list-timers --all 2>/dev/null | grep shenglong-mysql-backup' 2>/dev/null)"
if [ -z "$NEXT" ]; then
  bad "找不到 shenglong-mysql-backup.timer（备份不会自动跑）"
else
  echo "     $NEXT"
  if echo "$NEXT" | grep -qE "n/a|—"; then
    warn "定时器从未触发过（Last = n/a）→ 还没被证明过；可手动跑一次 systemctl start shenglong-mysql-backup.service 验证"
  else
    pass "定时器已有触发记录"
  fi
fi
echo

# ---------------------------------------------------------------- 10. 生产配置开关
echo "【10】生产关键开关（只打印开关本身，绝不打印密钥）"
cdl="$($SSH "cd $SERVER_DIR && grep -E '^(NODE_ENV|ALLOW_DEV_LOGIN|JWT_EXPIRES_IN)=' .env 2>/dev/null" 2>/dev/null)"
echo "$cdl" | sed 's/^/     /'
echo "$cdl" | grep -q 'ALLOW_DEV_LOGIN=true' && bad "ALLOW_DEV_LOGIN=true，生产环境不应允许开发态登录" || pass "未开启开发态登录"
echo "$cdl" | grep -q 'NODE_ENV=production' && pass "NODE_ENV=production" || warn "NODE_ENV 不是 production"
echo

# ---------------------------------------------------------------- 汇总
echo "=============================================="
echo "  结果：通过 $PASS / 警告 $WARN / 失败 $FAIL"
echo "=============================================="
[ "$FAIL" -eq 0 ] && echo "✅ 无阻塞项" || echo "❌ 有 $FAIL 项需要处理"
echo
echo "提示：本脚本只看「环境与运维面」。"
echo "      数据一致性 → npm run scan:hazards"
echo "      代码/库结构 → npm run preflight"
echo "      代码是否传全 → bash server/scripts/check-deploy-consistency.sh"

exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
