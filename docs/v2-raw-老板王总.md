# 【老板】王总 · 3 轮真实使用汇报

> 测试人：王总（48 岁，佛山厨具厂老板）
> 账号：`wangzong` / 角色 `boss` / 可管仓库 `[1,2]`（配件仓、成品仓）
> 同时使用两端：手机微信小程序 + 电脑后台管理系统（`admin` / `123456`）
> 数据标记：`[V2-SETUP]`；测试日期 2026-10-03
> 纪律声明：全程未改代码、未重启服务、未连库、未用 docker。仅操作名称带「【测试】」的物料（2100~2105、2112），另自建 1 个一次性物料 `【测试】王总临时料`(2113) 并已删除。**测试中一度误改张三(id7)的角色与手机号，已第一时间恢复并复验（见第 3 轮）。**

---

## 使用前提

我不天天进系统，但每周要对一次账。我最关心三件事：**库里值多少钱、这个月进出多少货、有没有人在乱来**。我在手机上用小程序看，在电脑上用后台看，最恼火的是**两个端看到的对不上，不知道信谁**。所以这 3 轮我按"对账"的习惯走，重点查数据可信度和两个端的一致性。

---

## 第 1 轮：按对账习惯走一遍（统计总览 → 台账 → 预警 → 流水 → 仓库总值 → 趋势）

### 操作过程

统一请求格式：`POST http://127.0.0.1:3000/api/{模块}`，头带 `Authorization: Bearer <王总token>`。

**1) `stats.overview`（首页总览）**
```json
{"code":0,"data":{"material_count":1919,"total_stock":947,"total_value":30836,"warning_count":1907,"zero_count":1906,"today_outbound_orders":3,"today_outbound_qty":20,"today_inbound_orders":2,"today_inbound_qty":149,"pending_outbound":3,"pending_inbound":2,"pending_checks":2},"message":"操作成功"}
```
- 看得懂：库存总量 947、库存价值 ¥30836、今日出/入库 3 单/2 单。
- **看不懂/被吓到**：`warning_count=1907`、`zero_count=1906`——1919 个物料里 1906 个"零库存"、1907 个"预警"，看着像仓库全空了。明明库里还有 947 件货。

**2) `stats.warehouseSummary`（各仓库存总值 · 本轮重点）**
```json
{"code":0,"data":{"list":[
 {"code":"peijian","name":"配件仓","material_count":1770,"total_stock":873,"total_value":28391.9988,"warning_count":1760,"_id":1},
 {"code":"chengpin","name":"成品仓","material_count":149,"total_stock":74,"total_value":2444,"warning_count":147,"_id":2}
]},"message":"操作成功"}
```
- **看得很明白**（加分）：成品仓值 ¥2444、配件仓值 ¥28391.9988，两仓分开列，名称、物料数、库存量、总值都在一行里。合计 30835.9988 ≈ 首页 total_value 30836，**对得上**。

**3) `stats.stockList`（库存台账）**
```json
{"code":0,"data":{"list":[{"name":"E2E测试料B-588729",...,"warehouse_name":"配件仓","stock_value":7931.9988,"_id":2111}, ...],"total":1919,"page":1,"pageSize":5,"total_value":30836},"message":"操作成功"}
```
- 台账总量、总值与首页一致。
- **别扭**：默认排在最前的是 `E2E测试料A/B-xxxxxx` 这类开发测试料，混在 1919 条里，我分不清哪些是真实库存。

**4) `stats.warning`（库存预警）**
```json
{"code":0,"data":{"list":[{"name":"【测试】刹车片 C型","current_stock":3,"warning_stock":5,"shortage":2,"severity":"low","_id":2102}],"total":1,"out_of_stock":0,"hint":"已隐藏从未发生过出入库的档案物料；如需查看全部请传 includeIdle=true"},"message":"操作成功"}
```
- **对不上（核心）**：首页说 1907 个预警，点进预警明细只有 **1** 条。虽然 `hint` 解释了"已隐藏档案物料"，但首页那个 1907 的大数字是错的/误导的。

**5) `stats.orderFlow`（单据流水）**
```json
{"list":[{"order_no":"OUT-20261003-003","status":"picking","status_text":"待拣货",...},{"order_no":"OUT-20261003-002","status":"receiving","status_text":"待收货",...},{"order_no":"OUT-20261003-001","status":"pending","status_text":"待确认",...}],"total":24}
```
- 看得懂，且**已经带中文 `status_text`**（待拣货/待收货/待确认），有单号、物料、数量、金额、经手人。

**6) `stats.stockFlow`（库存变动流水）**
```json
{"list":[{"material_name":"【测试】齿轮 G型","change_type":"inbound","change_quantity":24,"before_stock":0,"after_stock":24,"order_no":"IN-20261003-002","change_type_text":"入库",...}],"total":34,"net_quantity":947}
```
- 看得懂，每笔有"变动前/变动后/关联单号/经手人"，这是我要的追责链。

**7) `stats.trend`（趋势）**
```json
{"list":[{"date":"2026-10-01","outbound_orders":8,...,"inbound_orders":11,"inbound_amount":30236},{"date":"2026-10-03","outbound_orders":3,"outbound_qty":20,"inbound_orders":2,"inbound_amount":3470}],"days":7}
```
- 看得懂，7 天逐日列出。

### 遇到的问题

| 序 | 问题 | 严重度 | 证据（请求→响应） | 为什么干不下去 |
|---|---|---|---|---|
| 1-1 | 首页「预警物料」1907 与预警明细 1 条对不上；`zero_count` 1906 看着像仓库空了 | P1 | `overview`→`warning_count:1907`；`warning`→`total:1` + `hint:"已隐藏从未发生过出入库的档案物料"` | 大数字让我以为出事，点进去什么都没有，不敢信这个首页 |
| 1-2 | 库存台账/物料列表把开发测试料混在真实库存里 | P2 | `stockList`→首屏全是 `E2E测试料A/B-xxxxxx` | 分不清哪些是真实库存，导出对账时要人工剔 |

### 本轮结论

**能顺利完成，且有几个地方是真看明白的**：`warehouseSummary` 把成品仓值多少钱、配件仓值多少钱分开列得很清楚，这条正是我这次最想看的，**设计到位**。卡点在首页那个"预警 1907"的虚高数字——它和明细对不上，让我对首页第一眼就不信任。

---

## 第 2 轮：做错事与异常（驳回 / 作废 / 审批传错 / 重复操作 / 取消采购）

> 说明：为不干扰其他岗位正在走的 `[V2-SETUP]` 单据，我用【测试】物料 2100 自建了 2 张出库单（OUT-20261003-005 / -006）做异常用例。

### 操作过程

**1) 驳回一张出库单（填原因）**
```
请求: {"action":"reject","data":{"id":585,"reason":"用途不明，先驳回"}}
响应: {"code":0,"data":null,"message":"已驳回（该单尚未扣库存，无需回补）"}
```
提示语说人话，还主动说明了"没扣库存、不用回补"。

**2) 连续驳回两次同一张单**
```
请求: {"action":"reject","data":{"id":585,"reason":"再驳一次看看"}}
响应: {"code":0,"data":{"duplicated":true},"message":"该单据已被驳回，无需重复操作"}
```
幂等，提示清楚。**好评。**

**3) 作废一张已完成的出库单（关键：V2 说"已完成只有管理员能作废"）**
```
（先用 self 单据走完 提交→confirm→pickDone→receive，成为 completed；收货前后库存 95→90，扣减正确）
请求(老板): {"action":"cancel","data":{"id":586,"reason":"老板作废试试"}}
响应: {"code":0,"data":null,"message":"已作废，库存已回补"}
作废后 2100 库存回到 95（回补正确）
```
**老板账号（非 admin）作废已完成单竟然成功了。** 与 GUIDE「completed 只有管理员能作废」不符。前端 `admin/src/views/order/outbound.vue` 的 `canCancel()` 也是写 `status==='completed' && roles.includes('admin')`——**前端认为老板不行，后端却放行了**。

**4) 作废时不填原因**
```
请求: {"action":"cancel","data":{"id":587}}          // 不带 reason
响应: {"code":0,"data":null,"message":"已作废（该单尚未扣库存，无需回补）"}
再次: {"action":"cancel","data":{"id":587,"reason":"补一个原因"}}
响应: {"code":400,"data":null,"message":"该单据已作废"}
```
不填原因被允许，作废后 `cancel_reason` 为空，追责链缺一环。

**5) 去审批盘点（先把 `check.review` 的 `approve` 传错）**
```
先自建盘点单 CHK-20261003-001（成品仓 [2105]），提交实盘 actual_stock=50
请求: {"action":"review","data":{"id":165,"approve":"yes","remark":"故意传错"}}   // 字符串
响应: {"code":0,"data":{"approved":true,"adjusted":1,"details":["【测试】轴承 F型 账70→实50（差 -20）"]},"message":"审核完成，已按实盘数调整 1 项库存..."}
再次: {"action":"review","data":{"id":165,"approve":1}}        // 已完成，走到状态校验
响应: {"code":400,"data":null,"message":"当前状态「已完成」不支持审核"}
```
**`approve` 传字符串 `"yes"` 被判为"通过"，直接调了库存（70→50）。** 参数没有做严格布尔校验（truthy 即通过），"误传/前端传错"就会真调账。第 2 条因单据已被第 1 条消费掉，只验证了状态拦截，**approve 的类型校验结论以第 1 条为准**。

**6) 取消一张正在走流程的采购任务**
```
建任务: {"action":"create","data":{"warehouse_id":1,"items":[{"material_id":2100,"quantity":5}]}}
响应: {"code":0,"data":{"_id":6,"task_no":"CG-20261003-006"},"message":"采购任务已发布，已通知采购员"}
取消: {"action":"cancel","data":{"id":6,"reason":"预算不足，取消"}}
响应: {"code":0,"data":null,"message":"已取消该采购任务"}
再取消:  {"code":400,"data":null,"message":"该任务已取消"}
取消不存在: {"code":404,"data":null,"message":"采购任务不存在"}
```
提示语清晰，边界分明。

### 遇到的问题

| 序 | 问题 | 严重度 | 证据（请求→响应） | 为什么干不下去 |
|---|---|---|---|---|
| 2-1 | 老板（非 admin）能作废「已完成」出库单并回补库存，与文档/前端约定不符 | P1 | 老板 `cancel(id=586,reason)`→`{"code":0,"message":"已作废，库存已回补"}`；前端 `outbound.vue:265` 判 `includes('admin')` | 前端藏了按钮、后端却放行——权限口径不一致，出事了说不清谁有权 |
| 2-2 | `check.review` 的 `approve` 传任意 truthy 值即判通过并调库存 | P1 | `approve:"yes"`→`{"approved":true,"adjusted":1}` | 审批是"关卡"，传错就真调账，没有防线 |
| 2-3 | 作废可不填原因，作废原因留空 | P2 | `cancel(id=587)` 无 reason → 成功 | 事后追责时这一环是空的 |

### 本轮结论

**能完成，且系统错误处理整体不错**：重复驳回/重复取消/取消不存在 都给了"人话"提示且幂等。真正让我心里没底的是 **2-1 和 2-2**：一个"卡审批"的动作传错参数就放行，一个"只有管理员能干的作废"老板也能干——都是"关卡形同虚设"。

---

## 第 3 轮：权限边界 + 追责对账

### 操作过程 · A. 越权 / 乱来测试

**A1) 越过仓库范围操作（向仓库 3 提交出库）**
```
请求: {"action":"submit","data":{"warehouse_id":3,...}}
响应: {"code":400,"data":null,"message":"所选仓库与物料的实际所属仓库不一致，请刷新物料清单后重试"}
查仓库3物料: {"action":"list","data":{"warehouse_id":3}} → {"list":[],"total":0}
```
权限确实收住了（3 号仓看不到），但**提示语误导**：实际是"无权/仓库不存在"，却说成"物料与仓库不一致"。

**A2) 直接改库存（把 `current_stock` 塞进物料档案）**
```
请求: {"action":"upsert","data":{"_id":2113,...,"current_stock":9999}}
响应: {"code":400,"data":null,"message":"物料档案不能直接修改库存（你传了：current_stock）。库存只能通过「入库单」或「盘点调整」变更，这样才能留下可追溯的流水与责任人"}
```
**拦截成功，且提示语是我今天看到最好的一条**——既说明为什么不行，又给出正确路径。库存未被改动（仍为 0）。**好评。**

**A3) 改别人的资料 / 提权（这里踩雷了）**
```
改电话: {"action":"update","data":{"id":7,"phone":"13800000000"}}
响应: {"code":0,"data":null,"message":"资料已更新"}
提权:   {"action":"updateRole","data":{"id":7,"roles":["admin"]}}
响应: {"code":0,"data":null,"message":"角色已更新"}
```
- 我（老板）**既改了张三的资料，又直接把张三的角色改成了 admin**，后端无任何阻拦。
- **已立刻恢复**：`updateRole(id7,["out"])` 成功、`update(id7,phone:"")` 成功；复验 `user.detail(7)` → `roles:["out"], phone:""`，与初始一致。
- 隐患：老板自己能给别人发 admin，等于可以给自己造一个"超管"，这是**提权**。

**A4) 删除物料**
```
请求: {"action":"delete","data":{"id":2113}}   // 一次性测试料
响应: {"code":0,"data":null,"message":"删除成功"}
```
老板可删物料（软删）。对真实物料这属于高风险动作，虽与"老板/管理员可删"的设计一致。

### 操作过程 · B. 追责对账（我判断"账可不可信"的核心方法）

随机挑 3 个【测试】物料，把 `stats.stockFlow` 里它们的每笔变动**累加**，与当前库存对比：

| 物料 | 流水笔数 | 流水累加 | 当前库存 | 结论 |
|---|---|---|---|---|
| 2100 【测试】火花塞 A型 | 5 | 100**+**5回补**-**10**-**5**-**5 = **85** | 85 | **MATCH** |
| 2105 【测试】轴承 F型 | 3 | 50**+**20**-**20 = **50** | 50 | **MATCH** |
| 2112 【测试】齿轮 G型 | 1 | 24 | 24 | **MATCH** |

2100 的明细（原始响应节选）：
```
{"material_id":2100,"change_quantity":100,"before_stock":0,"after_stock":100,"order_no":"IN-20261001-001"}
{"material_id":2100,"change_quantity":-5,"before_stock":100,"after_stock":95,"order_no":"OUT-20261003-004"}
{"material_id":2100,"change_quantity":-5,"before_stock":95,"after_stock":90,"order_no":"OUT-20261003-006"}
{"material_id":2100,"change_quantity":5,"before_stock":90,"after_stock":95,"order_no":"OUT-20261003-006"}   // 出库撤销回补
{"material_id":2100,"change_quantity":-10,"before_stock":95,"after_stock":85,"order_no":"OUT-20261003-001"}
```
**3 个物料全部账实相符，且每笔"变动前→变动后"首尾相接、能追到单号和经手人。账是可信的。**

### 遇到的问题

| 序 | 问题 | 严重度 | 证据（请求→响应） | 为什么干不下去 |
|---|---|---|---|---|
| 3-1 | 老板可给任意用户改角色、直接授予 `admin`（提权） | **P0** | `updateRole(id=7,roles=["admin"])`→`{"code":0,"message":"角色已更新"}`；复验 `user.detail(7)`→`roles:["admin"]` | 谁能给自己/别人发超管权限，整个权限体系就塌了；这是安全越权 |
| 3-2 | 跨仓越权提示语误导 | P2 | `submit(warehouse_id=3)`→"所选仓库与物料的实际所属仓库不一致" | 我以为是物料选错了，其实是我没这仓库的权 |
| 3-3 | 老板可删物料 | P2 | `material.delete(2113)`→"删除成功" | 老板误点可删真实物料（有二次确认，但仍是高风险） |

### 本轮结论

**对账这一块完全达标，是我最满意的一轮**：3 个物料累加=库存，账实相符、流水可追责，`stockFlow` 的 `change_type_text`、`before/after_stock`、`operator_name` 齐全。**A2 直改库存被拦且提示极好**。但 **A3 是硬伤**：老板能给别人发 admin 权限，必须堵。

---

## 后台与小程序一致性（本轮重点，写得最细）

### 结论先行

> **老板说的「后台成品仓和前端小程序没同步」，在数据层面不存在。** 后台和小程序调的是**同一套后端接口、同一份数据**（成品仓都是 `warehouse_id=2`），实测逐项数值完全一致。老板"感觉没同步"的**真实根因是纯前端展示层不一致**——同一个数据，两端"显示的样子/位置/文案"不同，外加后台缺了小程序的两个新模块（消息中心、待拣货/待收货待办）。

### 证据 1：后台有没有 V2 的新东西（读代码逐项判断）

| V2 新功能 | 后台有没有 | 证据 |
|---|---|---|
| 出库单「待拣货 / 待收货」状态 | **有** | `admin/src/views/order/outbound.vue:10-15` 状态下拉含 `picking/receiving`；`:86-101` 有「拣货完成」「代确认收货」按钮；`:144-153` 详情显示拣货人/收货人/时间/库存扣减标记 |
| 「采购任务」功能页面 | **有** | 路由 `admin/src/router/index.js:106-109` → `admin/src/views/purchase/tasks.vue`，含发布/领取/录入/收料/退回/取消 |
| 「消息中心」 | **没有（缺页面）** | `admin/src/api/index.js:216-221` 定义了 `messageApi`，但 `admin/src/views/` 下**无任何 message 页面**、`router/index.js` 无 message 路由、`Layout.vue` 菜单无入口；而小程序有 `miniprogram/src/pages/message/list.vue` |
| 「待拣货/待收货」待办 | **没有** | 后台看板 `admin/src/views/dashboard.vue:31-45` 待办只有「待确认出库单/待确认入库单/待审核用户/进行中盘点/零库存」；小程序 `outbound.myNotice` 返回 `receiving_count/receiving_list` |

**额外发现（后台内部未适配 V2，最容易让老板误判"不同步"）**：
- 后台看板 `dashboard.vue:212-220` 的 `statusText` 只映射 `pending/confirmed/rejected/cancelled`，**缺 `picking/receiving/completed`**。同一张单，小程序显示「待收货」，后台看板会显示英文原码「receiving」。
- 后台「出入库统计」`admin/src/views/stats/overview.vue:59-65`（状态下拉）与 `:529-532`（`orderStatusText`）同样**只有旧状态**，筛不到「待拣货/待收货/已完成」。
- 对照：后台出库单页 `outbound.vue` 自己那份 `statusText` 是**全的**——所以**后台内部**两处文案都不一致，更别说和外部比。

### 证据 2：老板 vs 管理员，拉同一批数据比对（成品仓 warehouse_id=2）

```
请求(老板):  {"action":"list","data":{"warehouse_id":2,"page":1,"pageSize":500}}
请求(管理员): 同上
结果:
  老板  : total=149  rows=149  sum_stock=74  sum_value=2465.43
  管理员: total=149  rows=149  sum_stock=74  sum_value=2465.43
  库存值不一致的物料条数: 0
  物料 2105 老板=50 管理员=50 ；物料 2112 老板=24 管理员=24
```
**逐字段完全一致，差异为 0。** 差异来源只有「权限范围」这一种可能：管理员 `warehouse_ids=[]`（全局）、老板 `[1,2]`；但两者都能看仓 2，所以在成品仓上**构造不出权限差异**（本环境只有 1、2 两个仓，无法对比"无权仓"）。管理员调 `stats.warehouseSummary` 也返回了完整两仓数据（`code:0`），未按 GUIDE 所说"排除管理员"。

### 证据 3：后台「成品仓」到底怎么取数（破题关键）

老板怀疑：后台成品仓写死了 `warehouseCode:'chengpin'`，是不是和小程序按 `warehouse_id` 取的不是一份数据？

**查证结果——是同一份，`chengpin` 只用于「显示」，不参与「取数」：**
- `chengpin` 硬编码只出现在**路由 meta 与展示逻辑**：`router/index.js:78` 的 `meta.warehouseCode:'chengpin'`；`material/list.vue:215`（细分类叫「车间」）、`:221`（隐藏编号列）；`material/edit.vue`、`import.vue` 的回跳。
- 真正取数：`material/list.vue:176` 读 `route.meta.warehouseCode='chengpin'` → `:178-181` 在 `warehouseApi.list()` 里**按 code 反查仓库**，拿到 `_id=2` → `:195-198` `effectiveWarehouseId` → `:273-284` 调 `materialApi.list({warehouse_id:2})`。
- 小程序 `miniprogram/src/pages/in/create.vue:240`、`storekeeper/stock.vue:86` 等，同样调 `materialApi.list({warehouse_id})`。
- **两端最终落到同一个 `material.list{warehouse_id:2}` 接口**。`admin/src/views/dashboard.vue` 里**根本没有 `chengpin`**，它只调 `statsApi.overview/warning/orderFlow`，与小程序 `boss/dashboard.vue` 调的是同一批 `stats` 接口。

> 一句话：`warehouseCode:'chengpin'` 在后台只是"点哪个菜单 → 查哪个 warehouse_id"的映射表，**不是另一套数据源**。

### 证据 4：同一批 stats 接口，两端都调

| 数据 | 后台调用点 | 小程序调用点 | 同一份? |
|---|---|---|---|
| 仓库总值 | `stats/overview.vue:502` `statsApi.warehouseSummary()` | `boss/dashboard.vue:114` `statsApi.warehouseSummary()` | 是 |
| 首页总览 | `dashboard.vue:240` `statsApi.overview()` | `boss/dashboard.vue:137` `statsApi.overview()` | 是 |
| 预警 | `dashboard.vue:241` `statsApi.warning()` | `boss/warning` 页 | 是 |
| 单据流水 | `dashboard.vue:242` `statsApi.orderFlow()` | `boss/orders` 页 | 是 |

### 根因（一句话）

**「后台成品仓与小程序没同步」不存在于数据层——两端共用同一套后端接口、成品仓同为 `warehouse_id=2`、实测数值 0 差异；老板之所以觉得不同步，是因为后台的前端展示层没跟上 V2：看板/统计的状态文案缺 `待拣货/待收货/已完成`（同一张单小程序显示「待收货」、后台显示「receiving」），且后台没有「消息中心」和「待拣货/待收货」待办这两个小程序已有的入口。**

---

## 严重问题汇总

### P0 致命（不修我没法用）
1. **老板可给任意用户授予 `admin` 角色（提权）** —— `user.updateRole` 对 `boss` 不设限。证据：`updateRole(id=7,roles=["admin"])`→`{"code":0,"message":"角色已更新"}`。（已恢复：复验 `roles:["out"]`）

### P1 严重（很影响效率 / 有数据风险）
1. **`check.review` 的 `approve` 传任意 truthy 值即判"通过"并调库存** —— `approve:"yes"`→`{"approved":true,"adjusted":1}`，审批关卡形同虚设。
2. **老板（非 admin）能作废「已完成」出库单并回补库存** —— 与 GUIDE 及前端 `outbound.vue:265` 的 `includes('admin')` 约定不符。
3. **首页「预警物料」1906/1907 与预警明细 0/1 条对不上** —— `overview.warning_count` 与 `warning.total`(hint 隐藏档案物料)口径不一致；**两端一样**，会一致地误导老板。
4. **后台展示层未适配 V2**：看板 `dashboard.vue` 与统计 `stats/overview.vue` 的状态文案/筛选项缺 `待拣货/待收货/已完成`，把同一张单显示成英文原码。这是"以为没同步"的直接来源。

### P2 体验（能用但别扭）
1. 后台**没有消息中心页面**（`messageApi` 已定义但无 UI/路由/菜单），小程序有——老板在后台收不到驳回/待收货通知。
2. 后台看板**没有「待拣货/待收货」待办**，小程序 `myNotice` 有。
3. 作废出库单**可不填原因**，`cancel_reason` 留空，追责链缺环。
4. 跨仓越权提示语误导：`submit(warehouse_id=3)` 返回"所选仓库与物料的实际所属仓库不一致"（实际是"无权/仓库不存在"）。
5. 库存台账/物料列表把开发测试料（`E2E测试料…`）与真实物料混排，看不出哪些是真实库存。
6. 老板可删物料（`material.delete` 成功），对真实物料属高风险。

> **值得表扬（避免只报坏消息）**：① `warehouseSummary` 两仓分列、成品仓值多少钱一目了然；② 直改库存被拦且提示语是全场最佳（"库存只能通过入库单或盘点调整变更…"）；③ 重复驳回/重复取消/取消不存在 均幂等且提示清晰；④ **3 个物料流水累加 = 当前库存，账实相符可追责**。

---

## 我这个岗位愿不愿意继续用？为什么？

**愿意用，但要先修两个地方。**

对账这块（我最看重的）是真过关：成品仓/配件仓值多少钱分得清，单据流水和库存变动能追到单号和经手人，随机抽 3 个物料账实完全相符，直改库存还被系统挡住——**账我敢信**。驳回、作废、幂等这些日常操作也顺手，提示语大多说人话。

不敢用到底的原因有两个：
1. **权限关卡漏**：老板能给别人发 admin、审批传个 `"yes"` 就放行调账、已完成单老板也能作废——"管钱管账的关卡"不牢，我睡不踏实。
2. **两端看到的不一样**：不是数据错，是后台的样子跟不上——我在手机上看是「待收货」，到电脑看板变成英文；手机上弹的驳回通知，后台消息中心压根没有。**只要后台把 V2 的状态文案补齐、加一个消息中心/待办入口，我就不会再怀疑"两套账"了。**

只要把上面 1 个 P0 和头 2 个 P1 修掉，我天天用、周周对账都没问题。
