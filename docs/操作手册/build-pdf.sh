#!/usr/bin/env bash
# 把《文文进出库-岗位操作手册》的 HTML 重新渲染成 PDF。
# 改完 .html 之后跑一次这个脚本即可，不需要装任何 PDF 工具。
#
# 原理：用 Playwright 缓存里的 Chromium 无头打印。字体（微软雅黑）会以子集嵌入，
#      在任何电脑/手机上打开都不会乱码。打印样式（A4、页边距、彩色底纹）由 HTML 里的
#      @page 与 print-color-adjust: exact 控制。
set -euo pipefail
cd "$(dirname "$0")"

SRC="文文进出库-岗位操作手册.html"
OUT="文文进出库-岗位操作手册-20261020.pdf"

# 取版本号最大的那个 chromium（缓存目录带版本号，写死会失效）
CHROME="$(ls -d "$HOME"/AppData/Local/ms-playwright/chromium-*/chrome-win64/chrome.exe 2>/dev/null \
          | sort -V | tail -1)"
if [ -z "${CHROME}" ]; then
  echo "找不到 chromium，请确认 ~/AppData/Local/ms-playwright 下有 chromium-* 目录" >&2
  exit 1
fi

# ⚠️ chrome 不认 Git Bash 的 /g/sl/... 路径，必须转成 Windows 风格 G:/sl/...
#    之前踩过：传错路径 chrome 不报错，只吐一个 39KB 的空壳 PDF。
ROOT="$(cygpath -m "$(pwd)")"

# 中文路径容易出问题，先用纯 ASCII 临时名跑一遍
TMP_HTML="__tmp_manual.html"
TMP_PDF="__tmp_manual.pdf"
cp "$SRC" "$TMP_HTML"
"$CHROME" --headless=new --disable-gpu --no-sandbox \
  --run-all-compositor-stages-before-draw --virtual-time-budget=4000 \
  --no-pdf-header-footer \
  --print-to-pdf="$ROOT/$TMP_PDF" "file:///$ROOT/$TMP_HTML" 2>&1 | tail -1
mv -f "$TMP_PDF" "$OUT"
rm -f "$TMP_HTML"

echo "已生成：$OUT"
echo "自查：页数应为 22 左右；每页末行 y > 350（否则有半空页）；表格跨页时表头应重复。"
