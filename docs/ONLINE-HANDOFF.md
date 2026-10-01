# 胜龙进销存 · 上线 + 备案 交接单

> **创建**：2026-10-01 · **用途**：下次做「域名 + HTTPS + 备案接入 + 提审」时，**只看这一份就能接着干**
> **状态**：⏸ 卡在「等你提供 4 样信息」（见第五节），代码侧整改已完成
> **配套文档**：[RESUBMIT-GUIDE.md](./RESUBMIT-GUIDE.md)（提审文案与录屏脚本）、[PRE-SUBMIT-CHECKLIST.md](./PRE-SUBMIT-CHECKLIST.md)（提审前自检）

---

## 〇、一句话现状

微信审核被拒三条，**代码侧两条已整改完**，第三条（白屏）根因是「接口走 `http://IP:3000`，微信正式版直接拦断」。
解法：借用你本人已备案的 `ekkosys.cn` 的子域名 + HTTPS，落到腾讯云那台服务器上。
**代码还没部署到服务器**（服务器上跑的还是更早的版本，本轮 P0 修复与防重复提交都还没上线）。

---

## 一、事实基线（别再搞错的几件事）

| 项 | 正确值 | 易错点 |
|---|---|---|
| **服务器** | 腾讯云轻量 **`119.91.206.235`** | ⚠️ **不是** Ekko 那台（`101.133.139.175`）。两台别混 |
| **SSH 登录** | `ssh -i ~/.ssh/id_ed25519_sljxc ubuntu@119.91.206.235` | ⚠️ 用户名是 **`ubuntu`**，不是 `root`（之前连不上就是用户名错了） |
| **服务器系统** | Ubuntu 24.04 | |
| **后端现状** | systemd 服务 `shenglong-api`，Node 直接监听 `3000`，状态 active | 没走 Docker |
| **80 / 443** | **均空闲** | 已确认，可以给 nginx 用 |
| **nginx** | **未安装** | 需要新装 |
| **不能动的东西** | ① `8899` 端口的 Python 服务 ② `/opt/node` ③ 服务器上其他既有站点配置 | **红线**：只新增独立站点文件，不改既有配置 |
| **小程序 AppID** | `wx7c6f308d167e517c`（**个人主体**） | |
| **域名** | `ekkosys.cn`（**个人名义备案**，当前接入商是**阿里云**） | 主体与小程序一致 → 微信那关能过 |
| **计划用的域名** | `sljxc.ekkosys.cn`（名字可改，定了告诉我） | |

### 为什么能借 `ekkosys.cn`

微信对 `request` 合法域名的硬要求：① 必须 ICP 备案且**主体与小程序主体一致** ② 必须 HTTPS（TLS 1.2+）③ 不能用 IP、不能用免费二级域名。
`ekkosys.cn` 是你个人名义备案、小程序也是个人主体 → **主体一致，可行**。
子域名**不需要单独备案**，主域名备案通过后自动享有。

---

## 二、目标架构

```
微信小程序（正式版，强制 https）
        │  https://sljxc.ekkosys.cn
        ▼
  nginx（服务器 443，本轮新装）
        │  反代 → 127.0.0.1:3000
        ▼
  shenglong-api（systemd，Node）
        │
        ▼
     MySQL（仅容器/本机内网，不对外）
```

---

## 三、上线 7 步（按顺序，别跳步）

### 步骤 1 · 加 DNS 解析

在 `ekkosys.cn` 的**云解析**后台（域名在哪注册就去哪，见第五节第 4 项）新增一条：

| 记录类型 | 主机记录 | 记录值 | TTL |
|---|---|---|---|
| A | `sljxc` | `119.91.206.235` | 600 |

> ⚠️ **只加这一条**，不要改动 `ekkosys.cn` 上已有的解析记录（Ekko 项目还在跑）。

验证：`nslookup sljxc.ekkosys.cn` 应返回 `119.91.206.235`。

### 步骤 2 · 腾讯云提交「新增接入备案」（不可省）

备案跟**接入商**绑定。`ekkosys.cn` 现在在阿里云接入，解析到腾讯云后必须把接入也备过来，否则可能被拦。

- 入口：腾讯云控制台 → 备案 → **新增接入**
- 域名填 `ekkosys.cn`；材料：身份证、域名证书（阿里云控制台可下载）
- 耗时：腾讯云初审 1-2 个工作日 → 广东省管局 3-7 个工作日（最长 20 个）

> 好消息：这是「接入」不是「首次备案」，比新域名首次备案快很多。

### 步骤 3 · 申请 HTTPS 证书

- 腾讯云控制台 → SSL 证书 → 申请**免费 DV 证书**，绑定 `sljxc.ekkosys.cn`
- 或 Let's Encrypt（免费 90 天，须配自动续期）
- 或买张 1 年期 DV（几十元，省心）

> 下载后用 **nginx 格式**（`xxx_bundle.crt` + `xxx.key`）。

### 步骤 4 · 服务器装 nginx + 配站点

```bash
ssh -i ~/.ssh/id_ed25519_sljxc ubuntu@119.91.206.235

# 1) 装 nginx（Ubuntu）
sudo apt update && sudo apt install -y nginx

# 2) 建证书目录并上传证书（在本地执行 scp）
#    scp -i ~/.ssh/id_ed25519_sljxc sljxc_bundle.crt sljxc.key ubuntu@119.91.206.235:/tmp/
sudo mkdir -p /etc/nginx/ssl
sudo mv /tmp/sljxc_bundle.crt /etc/nginx/ssl/
sudo mv /tmp/sljxc.key /etc/nginx/ssl/
sudo chmod 600 /etc/nginx/ssl/sljxc.key
```

站点配置写到 **`/etc/nginx/conf.d/sljxc.conf`**（⚠️ 不要去改 nginx 默认站点的既有文件）：

```nginx
# 80 → 301 跳 443
server {
    listen 80;
    server_name sljxc.ekkosys.cn;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name sljxc.ekkosys.cn;

    ssl_certificate     /etc/nginx/ssl/sljxc_bundle.crt;
    ssl_certificate_key /etc/nginx/ssl/sljxc.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx     # 先测语法再 reload
curl -I https://sljxc.ekkosys.cn/health          # 期望 200
```

> Ubuntu 上 nginx 默认站点占着 80，若 `nginx -t` 报端口冲突：
> `sudo rm -f /etc/nginx/sites-enabled/default`（只删默认符号链接，不动 `conf.d/sljxc.conf`）。

### 步骤 5 · 改小程序接口地址并重新构建

`miniprogram/src/utils/cloud.js`：

```js
// 改前
const API_BASE = 'http://119.91.206.235:3000'
// 改后
const API_BASE = 'https://sljxc.ekkosys.cn'
```

```bash
cd miniprogram
npm run build:mp-weixin
node scripts/pre-submit-check.js      # 复核产物 DEV_MODE 为 false
```
然后在微信开发者工具里**上传**这一版。

> 同时把后端的图片/附件域名（若有硬编码 IP）一并换掉，否则会混出「部分请求被拦」。

### 步骤 6 · 微信后台配合法域名

微信公众平台 → 开发 → 开发管理 → 开发设置 → **服务器域名**：

- `request 合法域名`：`https://sljxc.ekkosys.cn`

保存后约 5-10 分钟生效。

### 步骤 7 · 提交审核

用 [RESUBMIT-GUIDE.md](./RESUBMIT-GUIDE.md) 第三节的备注文案 + 第四节录屏脚本一起提交。

---

## 四、部署本轮代码（和域名可以并行）

服务器上跑的还是更早版本，**本轮这两项修复还没上线**：

| 已改未部署 | 文件 | 说明 |
|---|---|---|
| P0 入库撤销回退加权成本 | `server/src/services/stock.js`、`server/src/modules/inbound.js` | 撤销入库单时按批次冲回 `avg_cost`，下限夹 0 |
| 供应商必填 + 前端防连点 | `inbound.js`、`miniprogram/src/utils/cloud.js`、4 个提交页 | 后端幂等键复用 + 前端提交闩锁。供应商：**采购入库必填**（后端兜底）；「入库登记」页**选填**（未填记为「其他入库」） |
| 入库页底部表单：可收起 + 输入框不再被裁（2026-10-01） | `miniprogram/src/pages/in/submit.vue` | 见下方「附：入库页两个前端问题的根因与修法」 |
| 全站输入框塌陷修复（2026-10-01） | `pages/my/profile.vue`、`out/submit.vue`、`purchase/submit.vue`、`check/submit.vue` | 同一个根因，一并修掉（5 处） |
| 入库页底部灰带修复（2026-10-01） | `miniprogram/src/pages/in/submit.vue` | 列表高度不再用 `calc(100vh - 690rpx)`，改「容器整屏 + 列表 flex:1」 |
| 同类页面一并收掉（2026-10-01） | `pages/out/submit.vue`、`purchase/submit.vue`、`check/submit.vue`、`check/list.vue` | 同一个魔法数字根因；这 4 页底部有固定栏，列表另加等于栏高的 `padding-bottom` |
| 清单抽屉空态瘦身（2026-10-01） | `pages/out/submit.vue`、`purchase/submit.vue` | 空清单不再展开抽屉（原本白占 60px 提示区、压住列表末条）；提示改由栏头承担 |

<details>
<summary><b>附：入库页列表底部「一大片空白」的根因与修法</b>（点开）</summary>

**现象**：入库登记页物料列表下方露出一大片纯灰底（用户截图 ≈ 屏幕高度 1/5）。

**根因**：列表高度写成了魔法数字 `height: calc(100vh - 690rpx)`，而列表上方的
「搜索栏 + 仓库条 + 分类条」实际只占 **375rpx**（实测）。多扣的 315rpx ≈ **187px**
就成了列表下方那条露底灰带——那里既没有列表内容，也不是列表本体，是容器裸背景。

实测（H5 390×844）：列表底 701 / 屏幕底 844 → **死区 143px**；小程序端因为顶部没有 H5 的
44px 导航条，同样算法下死区 ≈ **187px**，与用户截图吻合。

**修法**（不要再写魔法数字，两端通用）：

```scss
.container {
  height: calc(100vh - var(--window-top, 0px) - var(--window-bottom, 0px));
  display: flex; flex-direction: column;
  /* 原来的 padding-bottom: 500rpx 是面板时代的占位 hack，删掉 */
}
.material-list { flex: 1; min-height: 0; padding: 20rpx; }
```

- H5 端 `--window-top = 44px`（顶部导航条），小程序端为 `0px`（原生导航在 webview 之外，
  见 `app.wxss` 的 `page{--window-top:0px}`），`var(..., 0px)` 兜底，两端都成立。
- `min-height: 0` 必须有：flex 子项默认 `min-height:auto` 会被内容顶开，导致整页可滚动。
- 面板垫高层从 `1000rpx` 改成 `82vh`，与面板 `max-height:82vh` 对齐，保证任何屏幕尺寸下
  最后一张卡片都能滚出面板。

**验证**：死区 143px → **0**；整页可拖动距离 304px → **0**；滚到底最后一张卡片底 833 ≤ 屏幕底 844。

**同类页面（同一个魔法数字写法）已一并收掉** —— 有底部固定栏的页面不能只套 flex，
还要给列表加一段等于底部栏高度的 `padding-bottom`，否则最后一张卡片会被浮层盖住：

| 页面 | 修前死区 | 底部栏（实测栏高） | 列表垫高 | 修后 |
|---|---|---|---|---|
| `in/submit` 入库登记 | 143px | 无 | — | ✅ 死区 0，末卡底 833 ≤ 844 |
| `out/submit` 领料出库 | 143px | 清单栏 47px（90rpx） | `100rpx` | ✅ 死区 0，末卡底 792 ≤ 栏上沿 797 |
| `purchase/submit` 采购入库 | 195px | 清单栏 47px（90rpx） | `100rpx` | ✅ 同上 |
| `check/submit` 盘点提交 | 121px | 提交栏 121px（233rpx） | `240rpx` | ✅ 死区 0；无数据，用注入卡片验证末卡底 720 ≤ 栏上沿 723 |
| `check/list` 盘点列表 | 50px | 新建条 86px（165rpx） | `170rpx` | ✅ 死区 0；注入卡片验证末卡底 756 ≤ 栏上沿 758 |
| `in/history`、`out/history` | 0 | 无 | — | ✅ 本来就正常（靠整页滚动，末条可达） |

**顺带修掉的一个副作用**：出库/采购页的清单抽屉在**空清单时也展开**，
里面那句「点击上方物料加入清单」白占 60px，正好压在列表最后一张卡片上。
现在空清单不开抽屉（栏头文案承担提示：「入库清单 · 点下方物料加入」），
面板高度=栏头 47px，与列表垫高对齐；加料后的行为与以前完全一致。

**验证脚本**（都是真实浏览器驱动，可复跑）：

```bash
cd G:/sl/shenglong-erp
NODE_PATH="C:/Users/kass/.workbuddy/binaries/node/workspace/node_modules" \
  "C:/Users/kass/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" scripts/ui-probe-list-height.js
# ROUTES=a,b,c 可指定多页；死区 = innerHeight - min(list.bottom, innerHeight)
NODE_PATH=... node scripts/ui-verify-tail-synthetic.js   # 无数据页：注入卡片验证末条可达
NODE_PATH=... node scripts/ui-verify-cart-drawer.js      # 清单抽屉行为 13 项
```

⚠️ 写这类探针时注意：**不能用「scrollHeight > clientHeight」判定滚动容器** ——
列表没数据时先命中的是下拉刷新元素 `uni-scroll-view-refresher`，会得出假结论（本轮踩过）。
要按 `overflow: auto|scroll` 判定。

</details>

<details>
<summary><b>附：入库页两个前端问题的根因与修法</b>（点开）</summary>

**问题 1：输入框里的字显示不全（半截）**

根因不在业务代码，在 uni-app H5 的默认样式：

```css
uni-input { display: block; font-size: 16px; line-height: 1.4em; height: 1.4em; min-height: 1.4em; overflow: hidden; }
```

`uni-input` 被写死了 `height: 1.4em` 且 `overflow: hidden`。页面只写了上下 `padding`、没写高度时，
padding 会把内容区吃掉：实测外框只剩 **22px**、内层原生 `<input>` 只剩 **1px**，占位文字被裁成半截。

修法（5 处统一）：给 input 显式高度与行高，双端都成立，顺带把点击热区做到 88rpx（≈46px）。

```scss
height: 88rpx;
line-height: 88rpx;
padding: 0 24rpx;
box-sizing: border-box;
```

**问题 2：底部表单出现后收不回去**

原实现里这个面板**根本没有关闭入口**——没有关闭按钮、没有遮罩、点外面也没反应，
只有「提交成功」才会消失。实测确认：`hasCloseBtn: false`、`hasMask: false`。

修法：加了三条收起路径 + 一条换料路径。

| 操作 | 结果 |
|---|---|
| 点右上角 ✕ | 收起 |
| 点列表空白处 | 收起 |
| 再点同一个物料 | 收起（切换语义） |
| 点另一个物料 | 换料，面板保持打开 |

配套：面板加 `max-height: 82vh`（小屏不把按钮顶出屏幕）、列表底部加垫高层
（面板是浮层，不垫高的话最后几个物料永远滚不到面板上方、点不到）。

</details>


部署前先跑一遍本地回归（都应为全绿）：

```bash
cd server
node tests/api-test.js            # 期望 170/170
node tests/p0-cost-rollback-test.js   # 期望 56/56
node tests/duplicate-submit-test.js   # 期望 35/35
node src/db/verify.js             # 期望 1906 物料
```

> ⚠️ **Git 还没提交**，本轮所有改动都还是工作区里的。建议上线前先提交一版，方便回滚。

前端 UI 回归（真机视口 390×844，需先起 H5：`cd miniprogram && npm run dev:h5`）：

```bash
# 入库页：面板收起行为 + 输入框高度 + 列表可达性
NODE_PATH=<node_modules> node scripts/ui-inspect-in-submit.js
# 全站输入框体检：逐页实测有没有「文字被裁」的输入框
NODE_PATH=<node_modules> node scripts/ui-scan-inputs.js
# 出库 / 采购 / 我的 三页浮层与输入框
NODE_PATH=<node_modules> node scripts/ui-verify-panels.js
```

> 出库页（`pages/out/submit`）的购物车抽屉在这三个脚本里驱动不起来——
> 本地两个仓库的物料库存都是 0，而出库**按设计不允许领零库存的货**，
> 所以加不进清单。该页的 CSS 与已实测通过的采购页是逐字符相同的写法。

---

## 五、⏳ 待你提供（这 4 样给齐就能开工）

| # | 事项 | 具体要什么 | 影响 |
|---|---|---|---|
| 1 | **协议里的三处占位符** | `miniprogram/src/utils/legal.js` 里的 `OPERATOR_NAME`（你本人姓名）、`CONTACT_EMAIL`、`CONTACT_PHONE` | **不填，提审前自检脚本会直接报错拦下** |
| 2 | **子域名名字** | 默认建议 `sljxc.ekkosys.cn`，你要别的名字就告诉我 | 决定 DNS / 证书 / 域名配置 |
| 3 | **`ekkosys.cn` 的 DNS 管理入口** | 确认域名在**阿里云**还是**腾讯云**注册，决定步骤 1 去哪操作 | 决定 DNS 解析在哪加 |
| 4 | **测试微信 / 录屏** | 一个可用的测试微信号，或 1-2 分钟操作录屏 | 提审备注里的「测试方式」需要 |

（服务器 SSH 已确认可连，不用你再提供。）

---

## 六、提审前必办的安全项（别忘了）

| 项 | 现状 | 上线前要做的 |
|---|---|---|
| `WX_SECRET` | **为空** | 填入真实 AppSecret，否则微信登录换 openid 会失败 |
| `ALLOW_DEV_LOGIN` | **`true`** | 改为 `false`，否则线上存在「绕过微信登录」的口子 |
| 测试账号 | 内置 `dev_worker_01` 等 | 上线后**改强密码**，并保留「首次登录必须改密」门禁 |
| `DEV_MODE`（前端） | 已按构建环境注入，生产包为 `false` | `node scripts/pre-submit-check.js` 复核一次 |

---

## 七、审核驳回三条 · 整改状态

| 驳回原因 | 根因 | 状态 |
|---|---|---|
| 需补充隐私政策 | 一个小程序里一个协议页都没有，登录也无同意步骤 | ✅ 已整改（新增两页协议 + 登录前主动勾选） |
| 一进首页就要授权登录、无可浏览内容 | 首页是「请先登录」墙；`DEV_MODE` 写死 `true`，审核员一打开被自动登录 | ✅ 已整改（未登录可浏览介绍页；`DEV_MODE` 编译期注入，生产包 `false`） |
| 打开白屏 / 页面报错 | `API_BASE = http://119.91.206.235:3000`，IP + http 微信正式版两样都拦 | ⬜ **待办 = 本文档第三节** |

---

## 八、下次继续时的起手式

1. 打开本文档，看第五节 4 项是否齐了
2. 齐了 → 从**第三节步骤 1** 开始，按顺序走
3. 部署代码 → **第四节**（可并行）
4. 上线前安全项 → **第六节**
5. 提审 → 走 [RESUBMIT-GUIDE.md](./RESUBMIT-GUIDE.md)

**红线复述**：这台服务器上只做「新增」（新增 nginx 站点文件、新增证书目录），
不删不改已有的 `8899` Python 服务、`/opt/node`、以及任何既有站点配置。
