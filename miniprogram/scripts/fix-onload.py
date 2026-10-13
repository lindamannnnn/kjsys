# -*- coding: utf-8 -*-
"""把 6 个详情页的 onMounted+$page.options 取参方式改成 uni-app onLoad（小程序端兼容）"""
import io, re, os

BASE = r'G:/sl/shenglong-erp/miniprogram/src/pages'
FILES = ['check/detail.vue', 'out/detail.vue', 'purchase/detail.vue',
         'in/detail.vue', 'check/submit.vue', 'purchase/task-detail.vue']

for rel in FILES:
    p = os.path.join(BASE, rel)
    s = io.open(p, encoding='utf-8').read()

    # 1. vue 导入去掉 onMounted
    s = s.replace("import { ref, computed, onMounted } from 'vue'", "import { ref, computed } from 'vue'")
    s = s.replace("import { ref, onMounted } from 'vue'", "import { ref } from 'vue'")

    # 2. 加 onLoad 导入（紧跟 vue import 之后）
    if "from '@dcloudio/uni-app'" not in s:
        s = re.sub(r"(import \{[^}]*\} from 'vue'\n)",
                   r"\1import { onLoad } from '@dcloudio/uni-app'\n", s, count=1)

    # 3. 替换 onMounted 块
    pat = re.compile(
        r"onMounted\(\(\) => \{\n"
        r"  const pages = getCurrentPages\(\)\n"
        r"  const currentPage = pages\[pages\.length - 1\]\n"
        r"  (\w+)\.value = currentPage\.\$page\?\.options\?\.id \|\| ''\n"
        r"  (\w+)\(\)\n"
        r"\}\)")
    m = pat.search(s)
    if not m:
        print(f'!! {rel} 没匹配到 onMounted 块')
        continue
    var, loader = m.group(1), m.group(2)
    replacement = (
        "// 页面参数必须用 uni-app 的 onLoad 拿：getCurrentPages().$page.options 在\n"
        "// 微信小程序端拿不到 id（H5 能拿到），导致详情页数据全空、按钮不显示（V4 实测踩坑）\n"
        "onLoad((options) => {\n"
        f"  {var}.value = (options && options.id) || ''\n"
        f"  {loader}()\n"
        "})"
    )
    s = s[:m.start()] + replacement + s[m.end():]
    io.open(p, 'w', encoding='utf-8').write(s)
    print(f'OK {rel}  ({var} -> onLoad)')
