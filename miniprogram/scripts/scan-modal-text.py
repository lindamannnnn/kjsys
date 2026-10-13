# -*- coding: utf-8 -*-
"""扫小程序源码里所有 confirmText/cancelText，超过 4 个汉字的标出来（wx.showModal 硬限制）"""
import io, os, re, sys

BASE = r'G:/sl/shenglong-erp/miniprogram/src'
pat = re.compile(r"(confirmText|cancelText):\s*'([^']*)'|(confirmText|cancelText):\s*\"([^\"]*)\"")

for root, _, files in os.walk(BASE):
    for f in files:
        if not f.endswith('.vue'):
            continue
        p = os.path.join(root, f)
        for i, line in enumerate(io.open(p, encoding='utf-8'), 1):
            for m in pat.finditer(line):
                txt = m.group(2) or m.group(4)
                if txt and len(txt) > 4:
                    rel = os.path.relpath(p, BASE)
                    print(f'❌ {len(txt)}字 [{m.group(1) or m.group(3)}] "{txt}"  {rel}:{i}')
print('—— 扫描完 ——')
