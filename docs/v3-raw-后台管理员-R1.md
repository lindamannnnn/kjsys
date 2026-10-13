# 系统管理员 Agent 测试汇报（第 1 轮）

> 岗位：系统管理员（后台 `/admin/`，账号 `admin`）
> 环境：`http://127.0.0.1:3000`（未重启、未改任何代码）
> 时间：2026-10-03 11:44 ~ 11:52 UTC（本地 19:44 ~ 19:52）
> 证据目录：`G:/sl/shenglong-erp/.tmp-local-audit/sysadmin/`（`raw/` 下为逐条原始请求+响应）
> 说明：本次审计**全程只读**，未改动任何数据，未新建任何单据。

---

## 一、我干了什么

按时间顺序：

| # | 动作 | 目标 | 结果 |
|---|---|---|---|
| 1 | `POST /api/auth {adminLogin}` | 取 admin token | `code=0 登录成功`；user `_id=1`，`roles=["admin","boss"]`，`warehouse_ids=[]`（=全部仓） |
| 2 | 后台物料 | `material.list {warehouse_id:2}` / `categories` / `detail {id:2105}` | 全部 `code=0` |
| 3 | 后台仓库 | `warehouse.list` | `code=0`，2 个仓（`peijian`=1 配件仓 / `chengpin`=2 成品仓） |
| 4 | 后台供应商 | `supplier.list` / `supplier.search {keyword:"测"}` | `code=0`，各 4 条 |
| 5 | 后台用户 | `user.list` / `user.pendingCount` / `user.logs` | `code=0`，用户 15、日志 `total=3410` |
| 6 | 后台采购任务 | `purchase.list` / `purchase.detail {id:13}` / `purchase.assignees` | `code=0`，后台可见 **7 张全部任务** |
| 7 | 后台出库单 | `outbound.list` / `outbound.detail {id:608}` | `code=0`，`total=22`，明细 2 项 |
| 8 | 后台统计 | `stats.overview / orderFlow / warning / warehouseSummary`（另补 `trend / materialRank / operatorStats / stockList`） | 全部 `code=0` |
| 9 | 后台盘点 | `check.list` / `check.detail {id:168}` | `code=0`，盘点单 8 张 |
| 10 | **两端一致性核对** | admin vs `dev_boss`（小程序老板） | 见下方专节，**不一致条数 = 0** |
| 11 | 后台产物检查 | `admin/dist` 关键词 / 废弃角色名 / 时间戳 / 页面-路由对照 | 见第三节 |
| 12 | 静态托管检查 | `curl -I /admin/index.html`、探测不存在资源 | 见第三节 |

后台 17 项必测 action + 15 项补充 action，**共 32 次调用全部 `code=0`**，未发现后台功能缺失或报错。

---

## 二、我报的问题

### [P1] 测试手册写 `page_size`，服务端实际只认 `pageSize`——照手册传会被**静默忽略**（不报错、不警告，直接退回默认 20 条）

- **我做了什么（原始请求）**
  ```http
  POST /api/material
  {"action":"list","data":{"warehouse_id":2,"page":1,"page_size":100}}
  ```
- **系统回了什么（原始响应，关键字段）**
  ```json
  {"code":0,"message":"操作成功","data":{"list":[ ... 共 20 条 ... ],"total":149,"page":1,"pageSize":20}}
  ```
  → 请求了 `page_size:100`，服务端只回了 **20 条**，且响应里 `pageSize` 回显 `20`，**没有任何错误提示**。
- **对照实验（同一物料、同一页，仅改参数名）**
  ```
  page_size=100  -> returned=20   reported_pageSize=20      // 手册写法：被忽略
  pageSize=100   -> returned=100  reported_pageSize=100     // 实际生效写法
  ```
  其它模块同样复现（原始响应见 `raw/index-pagesize2.json`）：
  ```
  stats.warning {page_size:5} -> returned=20   | {pageSize:5} -> returned=5
  user.logs     {page_size:5} -> returned=15   | {pageSize:5} -> returned=5
  purchase.list {page_size:3} -> returned=8    | {pageSize:3} -> returned=3
  ```
- **根因（代码证据）**
  - `server/src/utils/format.js:93` —— `let pageSize = Math.floor(num(data.pageSize, 20))`，只读**驼峰** `pageSize`。
  - 全仓 `server/src` 下 **搜不到任何 `page_size`**（`grep -rn "page_size" server/src` → 0 命中）。
  - 所有模块都走 `paging(data)`（material / outbound / inbound / purchase / check / stats / user / supplier / message / auth），即**全部只认 `pageSize`**。
  - 两端客户端其实都传的是驼峰：`admin/src/api/index.js` 与 `miniprogram/src/utils/api.js` 搜 `page_size` 均 0 命中，实际用 `pageSize`。**所以这是手册与实现不一致，不是客户端 bug。**
  - 手册原文：`V3-TEST-GUIDE.md:188` `stockList {warehouse_id:2, page:1}`、`:191` `message.list → {page:1, page_size:20}`、`:185` `warning {page:1, page_size:20}` 均写 `page_size`；而上一版 `V2-TEST-GUIDE.md:139` 写的是 `pageSize`——即 **V3 手册引入的参数名笔误**。
- **我认为哪里不对 / 应该是什么样**
  参数名对不上时**要么生效、要么报错**，不该静默退回默认值。现状下：测试员/对接方照手册传 `page_size:1000` 想拉全量，会拿到 20 条却以为「数据就这么多」，最典型的后果就是**误判「两端数据不一致 / 数据丢了一半」**（本轮我如果只看单次返回，就会把 149 条误读成 20 条）。建议二选一：① 手册统一改成 `pageSize`；② 服务端同时兼容 `page_size`（`data.pageSize ?? data.page_size`）。
- **有没有证据**：**有**（原始请求+响应见 `raw/007-admin-material-list.json`、`raw/index-pagesize.json`、`raw/index-pagesize2.json`；代码见 `server/src/utils/format.js:93`）。

> 严重度说明：两端**已上线客户端都工作正常**，数据未被算错，故不评 P0；但「静默丢弃参数、照文档必踩、且无任何提示」符合 P1（容易错 / 提示误导）。

---

## 三、系统做对的地方

1. **两端同源同数（这是用户最关心的那件事）**：admin 与小程序老板 `dev_boss` 对 **两个仓共 1919 个物料全量逐 ID 比对**，`current_stock` 与 `avg_cost` **零不一致**；`stats.overview` 19 个字段零差异；`outbound.list` 两端 `total` 与 ID 集合完全一致。**「后台成品仓和小程序不同步」在本轮未复现**（详见下方专节）。
2. **后台数据范围正确**：admin 不锁仓库时 `material.list` `total=1919 = 配件仓1770 + 成品仓149`，即后台确实看到**全部**仓库数据（符合 `warehouse_ids=[]`=全部的设计）。
3. **仓库编码解析正确**：后台「成品仓物料」路由 `meta.warehouseCode='chengpin'`，经 `warehouse.list` 的 `code` 字段解析到 `_id=2`（`material/list.vue:178-198`），与小程序 `warehouse_id:2` 指向同一仓，不会串仓。
4. **后台产物是新的**：`admin/dist` 能搜到 `采购任务`、`消息中心`、`待拣货`、`待收货` 四个新功能关键词；搜不到已废弃角色名 `入库员`（0 命中）；`dist` 最新时间 **19:13:46** 晚于 `src` 最新时间 **19:12:40**，产物不旧。
5. **页面与路由一一对应**：`admin/src/views` 下 20 个 `.vue` **全部**已在 `router/index.js` 注册，无「有页面没路由」的孤儿页面（脚本 `check-routes.js` 输出 `未挂路由的页面数 = 0`）。
6. **`index.html` 不被缓存**：`/admin/index.html` 与 `/admin/` 均返回 `Cache-Control: no-store, no-cache, must-revalidate, max-age=0`，发版后用户不会看到旧后台首页；带 hash 的 JS 资源则是 `public, max-age=86400`（合理）。
7. **不存在的静态资源返回 404 而非 HTML**：`GET /admin/assets/not-exist-123.js` → `HTTP 404`，`Content-Type: application/json`，体 `{"code":404,...,"message":"接口不存在：GET /admin/assets/..."}`——**不会把 HTML 当 JS 返回**，不会因此白屏；同时 `/admin/not-a-real-page` → `200` 返回 index.html（SPA 回落），二者区分得当。`/admin`（无斜杠）→ `301 → /admin/`。
8. **管理员无 openid 时消息为空是设计如此**：`message.list` 返回 `list(0) total=0`、`unreadCount=0`（符合手册，非 bug）。
9. **统计口径自洽**：`stats.overview.pending_outbound=3 / picking_outbound=1 / pending_inbound=2` 与 `outbound.pendingCount=3 / outbound.pickingCount=1 / inbound.pendingCount=2` 完全对得上；`warehouse.list` 的 `material_count/total_stock/total_value` 与 `stats.warehouseSummary` 逐仓一致。

---

## 四、我这个岗位愿不愿意继续用 / 敢不敢签字

**愿意继续用，但暂不敢签字放行上线。**

- 后台功能层面：32 项 action 全绿，产物新、路由齐、静态托管无缓存/无白屏隐患，**可以继续日常使用**。
- 但用户报的「后台成品仓和小程序不同步」这件事，我只能签字到「**接口层两端一致**」——本轮逐 ID 全量比对零差异。用户反馈的现象如果仍存在，**不在数据接口层**，需进一步排查：是否用户浏览器缓存了旧 `index.html`（本轮确认服务端已发 `no-store`，若仍复现则是**用户侧**或 CDN 层）、或小程序端本地缓存、或用户把不同时间点的数字作对比。建议下一轮做一次**真机浏览器 + 小程序同屏同时间**的抓取复核。
- 卡点：手册 `page_size` 笔误（P1）不改，后续任何按手册做的测试/对接都会继续踩坑并可能**误报「数据不一致」**——这恰恰会干扰上面那条结论的判定。建议先修该条。

---

## 五、两端一致性核对的逐 ID 比对结果（含不一致条数）

> 方法：因发现 `material.list` **硬编码每页 20 条**（见 P1），故未使用 `page_size`，改为**按 `page` 逐页拉全量**；对每一页**交错请求 admin → boss**（把两端同一时刻的读数差压到最小），再按 `_id` 做集合并映射比对 `current_stock`、`avg_cost`（另附 `warning_stock`）。脚本：`.tmp-local-audit/sysadmin/scan.js`，落盘：`scan.json`。

### 5.1 物料主数据（全量，非抽样）

| 仓库 | admin 唯一 ID 数 | boss 唯一 ID 数 | admin total | boss total | **current_stock/avg_cost 不一致条数** | 仅 admin 有 | 仅 boss 有 |
|---|---|---|---|---|---|---|---|
| 成品仓 `warehouse_id=2` | 149 | 149 | 149 | 149 | **0** | 0 | 0 |
| 配件仓 `warehouse_id=1` | 1770 | 1770 | 1770 | 1770 | **0** | 0 | 0 |
| **合计** | **1919** | **1919** | — | — | **0** | **0** | **0** |

（1919 = 配件仓 1770 + 成品仓 149，与 `warehouse.list` 的 `material_count` 之和、与 `stats.overview.material_count=1919` 三方吻合。）

### 5.2 7 个测试物料逐 ID 明细（同一时刻两端读数）

| 物料 ID | 名称 | 仓 | admin 库存 | boss 库存 | admin 均价 | boss 均价 | 一致 |
|---|---|---|---|---|---|---|---|
| 2100 | 【测试】火花塞 A型 | 1 | 91 | 91 | 12.6053 | 12.6053 | ✅ |
| 2101 | 【测试】点火线圈 B型 | 1 | 54 | 54 | 35 | 35 | ✅ |
| 2102 | 【测试】刹车片 C型 | 1 | 13 | 13 | 25.0833 | 25.0833 | ✅ |
| 2103 | 【测试】机油滤芯 D型 | 1 | 37 | 37 | 9.9 | 9.9 | ✅ |
| 2104 | 【测试】空气滤芯 E型 | 1 | 30 | 30 | 18 | 18 | ✅ |
| 2105 | 【测试】轴承 F型 | 2 | 50 | 50 | 22.4286 | 22.4286 | ✅ |
| 2112 | 【测试】齿轮 G型 | 2 | 37 | 37 | 42.0294 | 42.0294 | ✅ |

> 不一致条数 = **0**。注意：上表库存/均价与 `v3-test-context.json` 的 `stock_now` 已有出入（如 2100 由 85→91、2112 由 24→37），这是**其它 4 个岗位本轮正在实时操作**导致的，属预期；关键是**同一时刻 admin 与 boss 两端读数完全相同**，说明库存变化对两端是**实时同源**的。

### 5.3 统计看板 `stats.overview`（admin vs boss 逐字段）

逐字段比对 **19 个字段，不一致条数 = 0**：

```
material_count=1919  total_stock=103351  total_value=6431802.11
warning_count=30     zero_count=11
today_outbound_orders=14  today_outbound_valid_orders=6  today_outbound_qty=42  today_outbound_amount=664.87
today_inbound_orders=5    today_inbound_qty=218           today_inbound_amount=4739.5
month_outbound_orders=22
pending_outbound=3   picking_outbound=1  receiving_outbound=1  pending_inbound=2
pending_users=0      pending_checks=3
```

（两端两次取样均为同一组值；`overview2_diff = []`。）

### 5.4 单据列表跨端总数

| 列表 | admin total | boss total | 两端 ID 集合是否相同 |
|---|---|---|---|
| `outbound.list` | 22 | 22 | **相同**（逐 ID 排序后完全一致） |
| `purchase.list` | 7 | 7 | 相同 |
| `check.list` | 8 | 8 | 相同 |

### 5.5 一致性核对结论

**后台（admin）与小程序（dev_boss）读的是同一份数据：本轮逐 ID 全量比对，1919 个物料不一致 0 条，统计与单据总数 0 差异。**
用户报的「后台成品仓和小程序不同步」**在数据接口层未复现**——两端调用的是同一套 `/api/*`、同一份库、同一查询路径。若线上仍有人看到不一致，最可能的剩余嫌疑是「**用户侧看到的是旧 `index.html`/旧缓存**」或「**操作时间点不同**」（本轮已确认服务端对 `index.html` 发 `no-store`，且 `dist` 为最新构建），建议后续用真机浏览器 + 小程序**同一时刻同屏**复核。

---

## 附：本轮证据文件索引（`.tmp-local-audit/sysadmin/`）

| 文件 | 内容 |
|---|---|
| `raw/001-admin-auth-adminLogin.json` … `raw/018-admin-check-list.json` | 后台功能逐项原始请求+响应 |
| `raw/index.json` / `raw/index-pagesize.json` / `raw/index-pagesize2.json` | 调用索引、`page_size` 探测 |
| `scan.json` / `scan.js` | 两端物料全量逐 ID 比对结果与脚本 |
| `step-c.json` / `step-c2.json` | overview / 单据列表跨端比对 |
| `test-material-compare.json` | 7 个测试物料逐 ID 比对 |
| `check-routes.js` 输出 | 页面-路由对照（20/20 已挂） |
