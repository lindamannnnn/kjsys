#!/usr/bin/env bash
# ============================================================
# 部署一致性检查：本地代码 ⇄ 生产代码（逐文件哈希对撞）
# ------------------------------------------------------------
# 为什么需要它：
#   生产目录 /opt/shenglong **不是 git 仓库**，部署靠手动传文件。
#   于是「本地改了但忘了传」「传了一半」这类问题**没有任何机制能发现**，
#   直到用户点到那个功能才炸 —— 这正是"上线又出报错"的典型来源。
#   2026-10-16 实测就抓到一处：migrate-outbound-4stage.js 本地已加固、
#   生产还是旧版（旧版会在已经切到新流程的库上误改历史单的扣账标记，且是静默的）。
#
# 比对口径：**去掉行尾 CR 后**再算 md5。
#   Windows 写出来的文件是 CRLF、服务器是 LF，直接比 md5 会全部"不一致"（假警报，踩过）。
#
# 用法（在本地仓库里跑）：
#   bash server/scripts/check-deploy-consistency.sh
#   SSH_TARGET=ubuntu@1.2.3.4 SSH_KEY=~/.ssh/id_rsa REMOTE_SERVER_DIR=/opt/app/server \
#     bash server/scripts/check-deploy-consistency.sh
#
# 退出码：0=完全一致；1=有差异（有漏传/多传/内容不同）；2=检查本身失败
# ============================================================
set -uo pipefail

SSH_TARGET="${SSH_TARGET:-ubuntu@119.91.206.235}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_sljxc}"
REMOTE_SERVER_DIR="${REMOTE_SERVER_DIR:-/opt/shenglong/server}"
LOCAL_SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATTERN="${PATTERN:-*.js}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" 2>/dev/null || true' EXIT

echo "=================================================="
echo "  部署一致性检查"
echo "  本地：$LOCAL_SERVER_DIR"
echo "  生产：$SSH_TARGET:$REMOTE_SERVER_DIR"
echo "=================================================="
echo

# ---------- 本地清单 ----------
( cd "$LOCAL_SERVER_DIR" && find src -type f -name "$PATTERN" | sort | while read -r f; do
    printf '%s %s\n' "$f" "$(tr -d '\r' < "$f" | md5sum | cut -d' ' -f1)"
  done ) > "$TMP/L" 2>/dev/null

# ---------- 远端清单 ----------
if ! ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=15 "$SSH_TARGET" \
  "cd '$REMOTE_SERVER_DIR' && find src -type f -name '$PATTERN' | sort | while read -r f; do printf '%s %s\n' \"\$f\" \"\$(tr -d '\r' < \"\$f\" | md5sum | cut -d' ' -f1)\"; done" \
  > "$TMP/P" 2>"$TMP/err"; then
  echo "❌ 连不上生产 / 目录不存在，检查中止："
  sed 's/^/   /' "$TMP/err"
  exit 2
fi

L_N=$(wc -l < "$TMP/L" | tr -d ' ')
P_N=$(wc -l < "$TMP/P" | tr -d ' ')
echo "本地 $L_N 个文件 / 生产 $P_N 个文件"
echo

# ---------- 对撞 ----------
diff "$TMP/L" "$TMP/P" > "$TMP/d" || true

if [ ! -s "$TMP/d" ]; then
  echo "✅ 完全一致：生产代码就是当前这份代码，没有漏传"
  exit 0
fi

# ---------- 分类：只在一边（漏传/多传） vs 两边都有但内容不同 ----------
# ⚠️ 不能拿 diff 的 < / > 行数直接当结论 —— 内容不同的文件**两侧都会出现**，
#    那样会把「内容不同」说成「文件不存在」（措辞误导过一次，必须按文件名集合求差）。
grep '^< ' "$TMP/d" | awk '{print $2}' | sort -u > "$TMP/lf" || true
grep '^> ' "$TMP/d" | awk '{print $2}' | sort -u > "$TMP/pf" || true
comm -23 "$TMP/lf" "$TMP/pf" > "$TMP/onlyL" || true # 只在本地 = 漏传
comm -13 "$TMP/lf" "$TMP/pf" > "$TMP/onlyR" || true # 只在生产 = 多传/手改
comm -12 "$TMP/lf" "$TMP/pf" > "$TMP/both" || true  # 两边都有，内容不同

cnt() { if [ -s "$1" ]; then grep -c . "$1"; else echo 0; fi; }
lookup() { awk -v k="$1" '$1==k{print $2}' "$2"; }

echo "❌ 有差异：同名但内容不同 $(cnt "$TMP/both") 个 / 只在本地 $(cnt "$TMP/onlyL") 个 / 只在生产 $(cnt "$TMP/onlyR") 个"
echo

if [ -s "$TMP/onlyL" ]; then
  echo "  ⚠️ 只在本地存在（**生产缺这些文件 = 漏传**）："
  while IFS= read -r f; do [ -n "$f" ] && echo "     · $f  （本地 $(lookup "$f" "$TMP/L")）"; done < "$TMP/onlyL"
  echo
fi

if [ -s "$TMP/onlyR" ]; then
  echo "  ⚠️ 只在生产存在（本地没有 = 可能被手工改过，需要回写仓库）："
  while IFS= read -r f; do [ -n "$f" ] && echo "     · $f  （生产 $(lookup "$f" "$TMP/P")）"; done < "$TMP/onlyR"
  echo
fi

if [ -s "$TMP/both" ]; then
  echo "  ⚠️ 同名但内容不同（上线后会被本地版本覆盖，先确认生产上没有需要保留的手工改动）："
  while IFS= read -r f; do
    [ -n "$f" ] && echo "     · $f   本地 $(lookup "$f" "$TMP/L") / 生产 $(lookup "$f" "$TMP/P")"
  done < "$TMP/both"
fi

# ---------- 差异明细：把前 3 个文件的真实 diff 打出来 ----------
# 目的：让人**一眼看出是实质改动还是只改了注释**，而不是对着哈希猜。
# 这一步直接决定「要不要重启服务」—— 只改注释不必重启，改了代码必须重启。
if [ -s "$TMP/both" ]; then
  echo
  echo "  ---- 差异明细（最多 3 个文件；< 本地 / > 生产）----"
  head -3 "$TMP/both" | while IFS= read -r f; do
    [ -z "$f" ] && continue
    # ⚠️ ssh 必须带 -n：否则它会把管道里剩下的文件名当 stdin 吃掉，
    #    循环只跑第一轮（踩过：3 个差异文件只打印了 1 个的明细）。
    ssh -n -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=15 "$SSH_TARGET" \
      "cat '$REMOTE_SERVER_DIR/$f'" 2>/dev/null | tr -d '\r' > "$TMP/r"
    tr -d '\r' < "$LOCAL_SERVER_DIR/$f" > "$TMP/l"
    echo
    echo "  === $f ==="
    diff "$TMP/l" "$TMP/r" | head -12 | sed 's/^/     /'
    echo "     …… 共 $(diff "$TMP/l" "$TMP/r" | grep -cE '^[<>]' || true) 行不同"
  done
fi

echo
echo "  → 处理：把本地版本补传上去（或确认生产上的手工改动是否需要回写到仓库），再跑一次。"
echo "     传完**记得重启后端**：改了代码不重启 = 文件新、进程旧，这个检查看不出来。"
exit 1
