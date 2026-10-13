# 系统管理员 Agent 测试汇报（第 2 轮）

> 岗位：系统管理员（后台 `/admin/`，账号 `admin`）
> 环境：`http://127.0.0.1:3000`（**未重启、未改任何代码**）
> 时间：2026-10-03 UTC（本地约 19:50 ~）
> 本轮主题：**故意乱填 / 越权**，看系统拦不拦
> 证据目录：`G:/sl/shenglong-erp/.tmp-local-audit/sysadmin-r2/`（`raw/` 为逐条原始请求+响应，`group-*.json` 为分组结果）
> 说明：所有自建/被改数据**已全部恢复原样**（见文末「已恢复」清单）。

---

## 一、我干了什么

按时间顺序（每条：动作 → 目标/ID → 结果）：

| # | 动作 | 目标 | 结果 |
|---|---|---|---|
| 1 | `auth.adminLogin` | admin/123456 | `code=0`，`_id=1`，`roles=["admin","boss"]`，无强制改密 |
| 2 | `user.list` / `warehouse.list` | 取用户与仓库基线 | 用户 15 个；仓库 2 个（1 配件仓 / 2 成品仓） |
| 3 | A 组 6 项 | `material.*` 乱填 | 拦 4、漏 2（见第二节） |
| 4 | B 组 7 项 | `user.*` 乱来 | 拦 6、按设计允许 1（禁用/启用 dev_out，已恢复） |
| 5 | B 组加测 2 项 | `user.approve` 提权探查 | **均未被拦**（见第二节 P0/P2） |
| 6 | C 组 6 项 | `dev_purchase`/`dev_out` 打管理接口 | **6/6 全拦 403** |
| 7 | D 组 2 项 | `pageSize` vs `page_size`；非法 `page` | 确认 `page_size` 被静默忽略；非法 page 回落第 1 页 |
| 8 | E 组 2 项 | admin vs `dev_boss` 逐 ID 比对 `current_stock` | 两仓共 **1920** 个物料，**不一致 0 条** |
| 9 | 清理 | 删除自建物料 2114/2115；还原 dev_in | 全部恢复，见文末 |

共 **23 项故意的越权/乱填尝试**（21 项指定 + 2 项主动加测）。

---

## 二、我报的问题

### [P0] `user.approve` 缺少「授予管理员」防护，**老板（boss）可借此把他人提升为 admin**，同时还顺带把禁用账号激活

- **我做了什么（原始请求）**（`raw/013-R2BESC-boss-user-approve.json`）
  ```http
  POST /api/user        （Authorization: Bearer <dev_boss 的 token>）
  {"action":"approve","data":{"id":26,"roles":["admin"],"warehouse_ids":[1,2]}}
  ```
  目标用户 `dev_in`（id=26）改动前是 `{"roles":["storekeeper"],"warehouse_ids":[1],"status":"disabled"}`。
- **系统回了什么（原始响应）**
  ```json
  {"code":0,"data":null,"message":"已通过审核，角色：admin"}
  ```
  回查 `user.detail {id:26}` → `{"roles":["admin"],"status":"active"}`：**不仅授予了 admin，还把一个已禁用账号直接激活了**。
- **为什么不对**
  - `user.updateRole` 里作者**明确写了**防护：`server/src/modules/user.js:159` ——
    `if (roles.includes('admin') && !myRoles.includes('admin')) return fail(403, '只有「管理员」才能授予「管理员」角色…')`。
  - 但 `user.approve`（同文件 `:113`）**完全没有这段判断**，只做了 `VALID_ROLES` 过滤。于是 boss 换了 `approve` 这个入口，就绕过了同一个控制。
  - 后果：boss 本不能授予 admin（admin 能作废已完成单据、管理用户），现在可以；这也意味着一台被降权/禁用的账号可被 boss 直接“复活+提权”。
- **应该是什么样**：authorize 的角色授予边界应在 `approve` 与 `updateRole` 两处**共用同一段校验**；`approve` 只允许对 `status='pending'` 的用户生效。
- **有没有证据**：**有**（原始请求+响应如上；还原记录 `raw/015/016/017-…`）。

### [P1] `material.upsert` 接受**不存在的 `warehouse_id`**，能建出“无归属仓库”的孤儿物料

- **我做了什么（原始请求）**（`raw/005-R2A4-admin-material-upsert.json`）
  ```http
  POST /api/material
  {"action":"upsert","data":{"name":"【测试】R2幽灵仓-…","warehouse_id":999,"unit":"个","warning_stock":10,"remark":"[V3-R2] A4 幽灵仓999"}}
  ```
- **系统回了什么（原始响应）**
  ```json
  {"code":0,"data":{"_id":2115},"message":"创建成功（新物料库存为 0，请通过入库单建账）"}
  ```
  回查 `material.detail {id:2115}` → `{"warehouse_id":999,"warehouse_name":null,"current_stock":0}`：**仓库 999 根本不存在**。
- **根因（代码证据）**：`server/src/services/warehouse.js:32` `resolveWarehouseId()` 对纯数字**直接 `return Number(s)`，不校验仓库是否存在**；`upsert` 仅用 `resolveWarehouseId` 拿到 id 后调 `requireWarehouseAccess(wid)`，而 admin/boss 的 `canAccessWarehouse` 恒为 true（`services/warehouse.js:86`），于是 999 直接放行入库。
- **后果**：`materials` 表无外键约束（`db/schema.sql:55` 无 `REFERENCES`），孤儿物料会**落库成功**：在 `material.list`（不锁仓）里以 `warehouse_name=null` 出现、把 `total` 顶大，`stats.overview.material_count` 也会被抬高，而任何按仓汇总都统计不到它——**账目对不平，且查不出归属**。
- **应该是什么样**：数字型 `warehouse_id` 也必须回查 `warehouses` 表确认存在（或至少 `Number > 0` 且在已知仓库集合内），否则 `fail(400,'所选仓库不存在')`。
- **有没有证据**：**有**（原始请求+响应如上）。

### [P2] `user.approve` 不校验用户状态：对 **active** 用户也能“审核通过”，并覆盖其角色

- **我做了什么（原始请求）**（`raw/011-R2B13x-admin-user-approve.json`）
  ```http
  POST /api/user
  {"action":"approve","data":{"id":27,"roles":["storekeeper"],"warehouse_ids":[1,2]}}
  ```
  目标 `dev_sk`（id=27）状态本就是 **active**。
- **系统回了什么（原始响应）**
  ```json
  {"code":0,"data":null,"message":"已通过审核，角色：storekeeper"}
  ```
- **为什么不对**：`approve` 只查 `real_name` 是否存在，**不查 `status` 是否为 `pending`**（`user.js:113-141`）。对已生效用户重复“审核”，会以传入的 `roles/warehouse_ids` **静默覆盖**其现有权限；本项因传入值与现状一致才没造成实际变化，但换个参数就是一次隐式改权。
- **应该是什么样**：`approve` 应 `if (user.status !== 'pending') return fail(400,'该用户不在待审核状态')`。
- **有没有证据**：**有**（原始请求+响应如上）。此条与上面 P0 是同一段代码的两个缺口。

### [P2] `material.upsert` 名称超长时抛数据库异常，前端只拿到笼统的 500

- **我做了什么（原始请求）**（`raw/003-R2A2-admin-material-upsert.json`）：`name` 传 1000 个「长」字。
- **系统回了什么（原始响应）**
  ```json
  {"code":500,"data":null,"message":"服务暂时无法处理该请求，系统已记录该错误，请联系管理员"}
  ```
  服务端日志（`srv-3000-v4.log:825`）：`[错误] material.upsert 数据库异常 Error: Data too long for column 'name'`（`ER_DATA_TOO_LONG`）。
- **为什么不对**：写操作虽被拦下（没有写入脏数据），但走的是「数据库异常」兜底分支，使用者看到的是“服务暂无法处理/请联系管理员”，**不知道是自己名称太长**。属于提示误导（P1 描述里的“文案误导人”）。
- **应该是什么样**：入参层限制 `name`（≤191 字，与 `VARCHAR(191)` 对齐）并返回可读提示，如「物料名称过长（最多 191 字）」。
- **有没有证据**：**有**（响应如上 + 服务端日志原文）。

### [P2] `material.upsert` 对 `warning_stock` 传负数**不报错、静默改成 0**

- **我做了什么（原始请求）**（`raw/004-R2A3-admin-material-upsert.json`）：`warning_stock: -5`。
- **系统回了什么（原始响应）**
  ```json
  {"code":0,"data":{"_id":2114},"message":"创建成功（新物料库存为 0，请通过入库单建账）"}
  ```
  回查 `detail {id:2114}` → `warning_stock: 0`。
- **为什么不对**：`utils/validate.js:81` `warningStock()` 对非法/负数**一律 `return 0`**，不抛错。用户填了 -5，系统不提示、直接按 0 归档，容易让人误以为“填进去了”。
- **应该是什么样**：要么在接口层明确拒绝负数（`fail(400,'预警库存不能为负数')`），要么在返回里回显“已按 0 处理”。静默改值最不可取。
- **有没有证据**：**有**（请求/响应 + `detail` 回查）。

### [P2] 分页参数 `page_size` 被**静默忽略**（服务端只认 `pageSize`）——独立复现上一轮的坑

- **我做了什么（对比请求）**（`raw/002-R2D20a` 与 `003-R2D20b`）
  ```
  同接口同页，仅改参数名：
  material.list {warehouse_id:2, page:1, pageSize:100}  -> returned=100  reported_pageSize=100
  material.list {warehouse_id:2, page:1, page_size:100} -> returned=20   reported_pageSize=20
  ```
- **系统回了什么（原始响应关键字段）**
  ```json
  {"code":0,"message":"操作成功","data":{"list":[…],"total":149,"page":1,"pageSize":20}}
  ```
  传 `page_size:100` 时**没有任何提示**，直接退回默认 20 条；`total` 仍是 149。在 `user.logs` 与 `stats.warning` 上同样复现：
  ```
  user.logs    pageSize:5 → 5 条 | page_size:5 → 20 条（total 都是 3516）
  stats.warning pageSize:5 → 5 条 | page_size:5 → 20 条（total 都是 32）
  ```
- **为什么仍要报**：本轮手册已把字段修正为 `pageSize`，**手册与实现的矛盾已消除**；但服务端对驼峰之外的写法**既不兼容也不报错**，属于“照旧习惯传就静默少一半数据”的坑，极易让人误判「数据丢了一半/两端不一致」。
- **有没有证据**：**有**（三个接口的对照原始响应）。代码根因：`utils/format.js:91` `paging()` 只读 `data.pageSize`，全仓无 `page_size`。

---

## 三、系统做对的地方

1. **越权接口全部拦死**：用 `dev_purchase` / `dev_out` 的 token 打 6 个管理接口（`user.list`、`user.updateRole`、`material.upsert`、`material.delete`、`stats.operatorStats`、`warehouse.upsert`），**6/6 全部 `code=403 无操作权限`**，一个都没漏。
2. **用户创建的三道必填校验都生效**：非法角色 `["superadmin"]` 被 `VALID_ROLES` 过滤后报「请至少分配一个角色」(400)；不传 `username` 报「登录账号不能为空」(400)；重名报「该登录账号已存在」(409)。
3. **不允许把角色清空**：`user.updateRole {id:27, roles:[]}` → `400 角色不能为空`（`user.js:150`），`dev_sk` 角色未被改动。
4. **有库存的物料删不掉**：`material.delete {id:2100}`（库存 91）→ `400 该物料当前库存为 91，不能删除。请先出库清零或调整库存`——**测试物料没有被误删**。
5. **不存在资源的读取/操作一律 404**：`material.detail {id:999999999}`、`user.resetPassword {id:999999999}`、`user.approve {id:999999999}` 均返回 `404`（分别是「物料不存在」「用户不存在」「用户不存在」）。
6. **不传名称被拦**：`material.upsert` 不传 `name` → `400 物料名称不能为空`。
7. **两端逐 ID 数据完全一致**：见第六节，`current_stock / avg_cost` **不一致 0 条**。
8. **非法 `page` 被防御式回落**：`user.logs {page:0}` 与 `{page:-1}` 都没报错、没 500、没错位，自动回落到第 1 页正常返回（`page:1`）。

---

## 四、我这个岗位愿不愿意继续用 / 敢不敢签字

**愿意继续用；第 1 轮那条功能结论不变（越权与乱填大部分被正确拦下，两端数据一致）。但本轮新发现 1 个 P0 提权口，在修掉之前不敢签字放行。**

- 卡点 1（P0）：`user.approve` 能被 boss 用来授予 `admin` 并激活禁用账号。这是**明确的越权提权路径**，且与 `updateRole` 已写的防护自相矛盾，必须优先修（两处共用校验）。
- 卡点 2（P1）：`material.upsert` 接受不存在的仓库 id，能造出孤儿物料污染统计口径；修掉前，任何经手 “仓库 id” 的写接口我都不放心。
- 其余（A2 文案、A3 静默改值、D20 静默忽略）是体验/易错问题，可排在后面，但 D20 会持续干扰“两端是否一致”的判定，建议顺手加上 `page_size` 兼容或强校验。

---

## 五、我做了 N 项越权/乱填尝试，系统拦住 M 项，漏 K 项

- **尝试总数 N = 23**（21 项指定 + 2 项主动加测）
- **系统拦住 M = 16**
- **漏掉 K = 5**（必测漏 3：A3、A4、D20；加测漏 2：B13x、BESC）
- 另有 1 项（B11 禁用/启用 `dev_out`）属**设计允许的正常管理动作**（非漏）；1 项（D21 非法 page）系统按**防御式回退**处理（合理）。

### 5.1 指定 21 项逐条

| 编号 | 我做的错事 | 请求关键参数 | 系统返回 | 判定 |
|---|---|---|---|---|
| A1 | upsert 不传 name | `{warehouse_id:1,unit:'个'}` | `400 物料名称不能为空` | ✅拦住 |
| A2 | name 传 1000 字 | `name='【测试】R2超长…'` | `500 服务暂时无法处理…` | ✅拦住(文案差→P2) |
| A3 | warning_stock 负数 | `warning_stock:-5` | `code=0` 创建成功，落库 `warning_stock=0` | ❌**漏** |
| A4 | warehouse_id 不存在 | `warehouse_id:999` | `code=0` 创建成功（孤儿料 2115） | ❌**漏** |
| A5 | 删有库存物料 | `delete {id:2100}`（库存91） | `400 该物料当前库存为 91，不能删除…` | ✅拦住 |
| A6 | detail 不存在 id | `detail {id:999999999}` | `404 物料不存在` | ✅拦住 |
| B7 | create 非法角色 | `roles:['superadmin']` | `400 请至少分配一个角色` | ✅拦住 |
| B8 | create 不传 username | 无 `username` | `400 登录账号不能为空` | ✅拦住 |
| B9 | create 重名 | `username:'admin'` | `409 该登录账号已存在` | ✅拦住 |
| B10 | updateRole 清空角色 | `{id:27,roles:[]}` | `400 角色不能为空` | ✅拦住 |
| B11 | 禁用 dev_out | `disable {id:25}` | `code=0 已禁用该账号`（随后 enable 恢复） | ➖设计允许 |
| B12 | resetPassword 不存在用户 | `{id:999999999,new_password:'abcdef'}` | `404 用户不存在` | ✅拦住 |
| B13 | approve 不存在用户 | `{id:999999999,roles:['out']}` | `404 用户不存在` | ✅拦住 |
| C14 | purchase→user.list | `{page:1,pageSize:5}` | `403 无操作权限` | ✅拦住 |
| C15 | purchase→user.updateRole | `{id:999999999,roles:['out']}` | `403 无操作权限` | ✅拦住 |
| C16 | out→material.upsert | `{name:'【测试】R2越权out…'}` | `403 无操作权限` | ✅拦住 |
| C17 | out→material.delete | `{id:999999999}` | `403 无操作权限` | ✅拦住 |
| C18 | out→stats.operatorStats | `{}` | `403 无操作权限` | ✅拦住 |
| C19 | purchase→warehouse.upsert | `{_id:999999999,name:'【测试】R2越权仓'}` | `403 无操作权限` | ✅拦住 |
| D20 | page_size vs pageSize | `page_size:100` vs `pageSize:100` | 20 条 vs 100 条，前者**无提示** | ❌**漏**(静默忽略) |
| D21 | user.logs 非法 page | `page:0` / `page:-1` | 均 `code=0`，`page` 回落为 1 | ➖防御式回退 |

### 5.2 主动加测 2 项（未被拦）

| 编号 | 我做的错事 | 请求 | 返回 | 判定 |
|---|---|---|---|---|
| B13x | 用 admin `approve` 一个**非 pending(active)** 用户 dev_sk | `{id:27,roles:['storekeeper'],warehouse_ids:[1,2]}` | `code=0 已通过审核…` | ❌**漏**（P2） |
| BESC | 用 **boss** token `approve` 授予 dev_in 为 `admin` | `{id:26,roles:['admin'],warehouse_ids:[1,2]}` | `code=0 已通过审核，角色：admin` | ❌**漏**（P0） |

---

## 六、两端逐 ID 比对结果（不一致条数）

> 方法：admin 与 `dev_boss` 对同一仓、**同一页交错请求**（admin→boss 各一页）以压缩时间差；按 `_id` 做集合并映射，逐 ID 比对 `current_stock / avg_cost / warning_stock`。脚本 `group-e.js`，落盘 `group-e.json`，原始报文 `raw/*-R2E*`。

| 仓库 | admin 唯一 ID | boss 唯一 ID | admin total | boss total | **不一致条数** | 仅 admin 有 | 仅 boss 有 |
|---|---|---|---|---|---|---|---|
| 成品仓 `warehouse_id=2` | 149 | 149 | 149 | 149 | **0** | 0 | 0 |
| 配件仓 `warehouse_id=1` | 1771* | 1771* | 1771* | 1771* | **0** | 0 | 0 |
| **合计** | **1920** | **1920** | — | — | **0** | **0** | **0** |

\* 配件仓那一刻是 1771 条，其中 1 条是我 A 组自建的测试物料（2114）；**清理后已回到基线 1770 条**（复核 `wh1 total=1770`、`wh2 total=149`）。

7 个测试物料逐 ID 明细（同一时刻两端读数，`current_stock` 全部一致）：

| 物料 ID | 名称 | admin 库存 | boss 库存 | 一致 |
|---|---|---|---|---|
| 2100 | 【测试】火花塞 A型 | 91 | 91 | ✅ |
| 2101 | 【测试】点火线圈 B型 | 54 | 54 | ✅ |
| 2102 | 【测试】刹车片 C型 | 2 | 2 | ✅ |
| 2103 | 【测试】机油滤芯 D型 | 37 | 37 | ✅ |
| 2104 | 【测试】空气滤芯 E型 | 25 | 25 | ✅ |
| 2105 | 【测试】轴承 F型 | 50 | 50 | ✅ |
| 2112 | 【测试】齿轮 G型 | 37 | 37 | ✅ |

**结论：本轮两端不一致条数 = 0。**（注：部分库存值与本轮 `v3-test-context.json` 的 `stock_now` 已有出入，如 2102 由 13→2、2104 由 30→25，属其它 4 个岗位**同时在线操作**所致，关键在同一时刻两端读数完全相同。）

---

## 附：已恢复清单（做完全部还原）

| 对象 | 改动 | 恢复动作 | 复核结果 |
|---|---|---|---|
| 物料 2114（A3 负预警） | 新建 | `material.delete {id:2114}` | `code=0 删除成功`，`detail` 返回 404；`wh1 total` 回 1770 |
| 物料 2115（A4 幽灵仓） | 新建 | `material.delete {id:2115}` | `code=0 删除成功`，`detail` 返回 404 |
| 用户 26 `dev_in`（BESC） | boss 将其 approve 为 `admin` + 激活 | `updateRole {roles:['storekeeper'],warehouse_ids:[1]}` + `disable` | 回查 `{roles:['storekeeper'],warehouse_ids:[1],status:'disabled'}` = **与改动前完全一致** |
| 用户 25 `dev_out`（B11） | 禁用 | `user.enable {id:25}` | 回查 `status=active` |
| 用户 27 `dev_sk`（B10/B13x） | 无实际变化（清空被拦；approve 传原值） | 无需恢复 | 复核 `roles=['storekeeper']` |
| 物料 2100（A5） | 删除被拦 | 未删除 | 仍存在，库存 91 |

> 其它岗位的并发操作（如 2102/2104 库存变化）不在我的改动范围内，未作干预。

> 补充说明：核验时发现库里存在一个**并非由我创建**的账号 `id=52 / V3R2_audit_1791028547046 / real_name="[V3-R2]越权测试账号"`（`status=disabled`，`created_at=2026-10-03T11:55:47Z`）。该账号的命名与我的脚本命名规则（`r2_superadmin_*` / `r2_esc_*`）不同，判断是**并行的另一名「后台管理员 R2」测试者**所建且已被其禁用；**非我改动，故未删除**，特此说明以免混淆。

## 附：证据文件索引（`.tmp-local-audit/sysadmin-r2/`）

| 文件 | 内容 |
|---|---|
| `raw/003-R2A2…json` | A2 超长名称原始请求+响应（配合 `srv-3000-v4.log:825` 日志） |
| `raw/004-R2A3…json` / `005-R2A4…json` | A3 负预警、A4 幽灵仓的原始请求+响应 |
| `raw/011-R2B13x…json` | approve 非 pending 用户 |
| `raw/012~017-R2BESC…json` | boss 用 approve 提权 + 完整还原过程 |
| `raw/002~003-R2D20…json` | `pageSize` vs `page_size` 对照 |
| `raw/*-R2C14~C19*.json` | 6 项越权对照原始报文 |
| `raw/*-R2E*.json` | 两端逐 ID 比对逐页原始报文 |
| `group-a.json` ~ `group-e.json`、`index-*.json` | 分组结果与调用索引 |
