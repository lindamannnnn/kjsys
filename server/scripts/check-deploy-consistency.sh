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

LOCAL_ONLY=$(grep -c '^<' "$TMP/d" || true)
REMOTE_ONLY=$(grep -c '^>' "$TMP/d" || true)

echo "❌ 有差异（本地有而生产没有：$LOCAL_ONLY 条 / 生产有而本地没有：$REMOTE_ONLY 条）"
echo
echo "  下面「本地文件路径 哈希」里，与生产不同的那些："
echo

# 逐行列出，并尽量配上「同一文件两边哈希」的对照
awk '/^< /{lf=$2; lh=$3} /^> /{print lf" | 本地 "lh" | 生产 "$3}' "$TMP/d" | while IFS= read -r line; do
  echo "  · $line"
done

# 只在一边存在的文件（漏传 / 多传）。
# ⚠️ 不能直接拿 diff 的 < / > 行当「只在一边」—— 内容不同的文件两侧都会出现，
#    那样会把「内容不同」误报成「文件不存在」。必须按文件名集合求差。
grep '^< ' "$TMP/d" | awk '{print $2}' | sort -u > "$TMP/lf" || true
grep '^> ' "$TMP/d" | awk '{print $2}' | sort -u > "$TMP/pf" || true
LOCAL_ONLY_FILES=$(comm -23 "$TMP/lf" "$TMP/pf" || true)
REMOTE_ONLY_FILES=$(comm -13 "$TMP/lf" "$TMP/pf" || true)

if [ -n "$LOCAL_ONLY_FILES" ]; then
  echo
  echo "  ⚠️ 只在本地存在（生产缺这些文件）："
  echo "$LOCAL_ONLY_FILES" | sed 's/^/     /'
fi
if [ -n "$REMOTE_ONLY_FILES" ]; then
  echo
  echo "  ⚠️ 只在生产存在（本地没有，可能被手工改过）："
  echo "$REMOTE_ONLY_FILES" | sed 's/^/     /'
fi
if [ -z "$LOCAL_ONLY_FILES" ] && [ -z "$REMOTE_ONLY_FILES" ]; then
  echo
  echo "  （文件个数一致，差异都是「同名文件内容不同」——上线后会被新版本覆盖，注意确认）"
fi

echo
echo "  → 处理：把本地版本补传上去（或确认生产上的手工改动是否需要回写到仓库），再跑一次。"
exit 1
