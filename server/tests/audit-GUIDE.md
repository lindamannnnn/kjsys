# 胜龙进销存 · 4 角色功能审核手册

> 本手册供「岗位使用者 Agent」使用。所有字段名、权限、业务语义均**逐条核对过服务端源码**，
> 未核对过的内容会在文中标注「未核实」。请严格按手册操作，避免把手册错误当成系统缺陷。

---

## 一、被测系统

| 项 | 值 |
|---|---|
| 后端 API | `http://119.91.206.235:3000/api/<模块>` |
| Web 后台 | `http://119.91.206.235:3000/admin/`（账号 `admin` / `ssCW9GF0DJu1`） |
| 前端（小程序） | 已构建 H5 版供浏览器验证：`http://127.0.0.1:8090`（微信小程序端同一套代码） |
| 数据库 | 服务器 MySQL，**1906 条真实物料 + 6 条【测试】物料** |
| 业务起始状态 | 真实物料库存全 0；测试物料已有基线库存；3 张待确认单据 |

### ⚠️ 铁律：只准操作【测试】物料

真实物料共 1906 条，是胜龙公司的真实资产数据。**任何写操作（入库/出库/盘点/改价）只允许针对
名称以 `【测试】` 开头的 6 条物料**。清理脚本带护栏，一旦发现真实物料库存被动过就会中止清理，
届时整个测试结论都会作废。读操作（列表、查询、统计）不受此限。

---

## 二、登录

### 统一请求格式（与前端 `callCloud` 完全一致）

```bash
curl -s -X POST "http://119.91.206.235:3000/api/outbound" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <你的token>" \
  -d '{"action":"submit","data":{...}}'
```

**统一返回**：`{"code":0,"message":"...","data":{...}}`
- `code === 0` 表示成功，业务数据在 `data`
- `code !== 0` 表示失败，`message` 是给用户看的中文提示
- `code === 401` 表示登录失效

### 四个岗位账号（密码统一 `Audit@2026`）

| 岗位 | 账号 | 角色 | 可管仓库 | 你负责的测试物料 |
|---|---|---|---|---|
| 出库员 张三 | `audit_out` | `out` | 仅 1（配件仓） | 火花塞 A型(id=1953)、点火线圈 B型(1954) |
| 采购员 李娜 | `audit_purchase` | `purchase` | 仅 1（配件仓） | 机油滤芯 D型(1956)、空气滤芯 E型(1957) |
| 仓管员 赵六 | `audit_sk` | `storekeeper` | 1 和 2（两仓） | 刹车片 C型(1955) + 处理待确认单据 |
| 老板 王总 | `audit_boss` | `boss` | 1 和 2（两仓） | 轴承 F型(1958，成品仓) |

登录：
```bash
curl -s -X POST "http://119.91.206.235:3000/api/auth" \
  -H "Content-Type: application/json" \
  -d '{"action":"adminLogin","data":{"username":"audit_out","password":"Audit@2026"}}'
```
从返回的 `data.token` 取出令牌，后续所有请求带上。

---

## 三、动作清单与权限矩阵

### 权限规则（源码 `roleRules`，**这是判 P0 的依据**）

| 模块.动作 | 允许的角色 | 备注 |
|---|---|---|
| `outbound.submit` | out, purchase, storekeeper, boss, admin | 提交出库 |
| `outbound.confirm` | storekeeper, boss, admin | 确认（**不动库存**） |
| `outbound.reject` | storekeeper, boss, admin | 驳回（**必须填 reason**） |
| `outbound.cancel` | 无 roleRules，按单据归属+仓库权限 | 撤销（回补库存） |
| `inbound.submit` | in, purchase, storekeeper, boss, admin | 提交入库 |
| `inbound.confirm` | storekeeper, boss, admin | 确认（**不动库存**） |
| `inbound.updatePrice` | in, purchase, boss, admin, storekeeper | 改价（仅未确认时？见第六节） |
| `check.create` | boss, admin, storekeeper | 建盘点任务 |
| `check.submit` | storekeeper, boss, admin | 录入盘点结果 |
| `check.review` | **boss, admin** | 审核盘点（仓管不能审自己的） |
| `material.upsert` | boss, admin, storekeeper | 建/改物料 |
| `material.delete` / `import` | boss, admin | 删/导入物料 |
| `stats.overview` | boss, admin, storekeeper | |
| `stats.trend` | **boss, admin** | 出库员/采购员/仓管**都无权** |
| `stats.stockList` | boss, admin, storekeeper, in, out, purchase | 全员可看 |
| `stats.orderFlow` | boss, admin, storekeeper, purchase | **出库员无权** |
| `stats.warning` | boss, admin, storekeeper, purchase | **出库员无权** |
| `stats.stockFlow` | boss, admin, storekeeper, purchase | |
| `stats.materialRank` / `operatorStats` | boss, admin | |
| `stats.warehouseSummary` | boss, admin, storekeeper, in, out, purchase | |
| `user.*`（全部） | boss, admin | 出库员/采购员/仓管都无权 |

### 各动作真实参数（源码核对）

```js
// 出库单
outbound.submit   { type, remark, warehouse_id?, items:[{material_id, material_name, material_spec, unit, quantity}], client_request_id? }
outbound.list     { page, pageSize, status?, warehouse_id?, keyword? }
outbound.detail   { id }
outbound.confirm  { id }
outbound.reject   { id, reason }          // reason 必填
outbound.cancel   { id, reason }          // reason 可为空
outbound.pendingCount {}                  // 无参数
outbound.myNotice {}                      // 看自己被驳回的单

// 入库单
inbound.submit    { type, supplier, supplier_id?, remark, warehouse_id?, items:[{material_id, material_name, material_spec, unit, quantity, unit_price}] }
inbound.list      { page, pageSize, status?, warehouse_id?, keyword? }
inbound.detail    { id }
inbound.confirm   { id }
inbound.cancel    { id, reason }
inbound.updatePrice { id, unit_price }                        // 单明细时
inbound.updatePrice { id, items:[{material_id, unit_price}] }  // 多明细时必须这样传

// 盘点
check.create      { type, warehouse_id, scope:{material_ids:[...]} , remark, confirm_full_scan? }
check.list        { page, pageSize }
check.detail      { id }
check.submit      { id, items:[{material_id, actual_stock}] }   // 字段名是 actual_stock
check.review      { id, approve:true|false, remark }            // 只有老板/管理员
check.cancel      { id, reason }

// 物料
material.list       { keyword?, warehouse_id?, sub_category?, category?, page, pageSize }
material.detail     { id }
material.categories { warehouse_id }
material.upsert     { _id?, name, spec, category, sub_category, unit, warehouse_id, warning_stock, material_no, remark }
                     // ⚠️ 传 current_stock/avg_cost 会被拒绝（设计如此：库存只能走单据）

// 统计
stats.overview    { warehouse_id? }
stats.trend       { days?, warehouse_id? }
stats.stockList   { warehouse_id?, keyword?, page, pageSize }
stats.orderFlow   { page, pageSize, warehouse_id?, type? }
stats.warning     { warehouse_id? }
stats.stockFlow   { material_id?, warehouse_id?, page, pageSize }
stats.warehouseSummary {}

// 供应商
supplier.list   { keyword?, page, pageSize }
supplier.upsert { _id?, name, contact, phone, address, remark }
supplier.delete { id }
```

---

## 四、关键业务语义（**最容易误判成 bug 的地方**）

1. **库存变动时机**：出库/入库 **「提交」时库存立即变动**（扣/加）。
   之后的**「确认」只改状态、不动库存**。这是设计，不是 bug。
   → 所以「我提交了但没确认，库存就少了」是**正常行为**。

2. **撤销/驳回才回补库存**：`outbound.cancel` 回补、`outbound.reject` 回补。

3. **确认 ≠ 修改库存**：仓管点「确认」后库存数字**不会变**，别把这个当成「确认没生效」。

4. **入库不可驳回**：入库单只有 confirm / cancel，**没有 reject**（设计如此）。

5. **盘点流程是两人接力**：仓管/老板**建立**任务 → 仓管**录入并提交** → **只有老板**能 `review` 通过或退回。
   仓管审不了自己提交的盘点单。

6. **盘点退回用 `check.review{approve:false}`**，退回后库存完全不动。

7. **提交即校验库存**：库存不足时 `outbound.submit` 直接失败并提示当前库存量。
   → 所以「库存 0 时出库被拒」是**正常拦截**，不是 bug。

8. **仓库隔离**：`warehouse_ids` 为**空数组 = 可见全部仓库**；非空 = 只能操作列出的仓库。
   本次 4 个账号都是非空（张三/李娜只有仓 1，赵六/王总有仓 1、2）。

9. **一张出库单不能混多个仓库的物料**，会报错要求分开提交。

10. **幂等**：提交时带相同 `client_request_id` 只会生效一次，第二次返回 `duplicated: true`。

11. **改价只看是否已确认**：已确认的入库单改价，成本要能正确回滚重算（重点测）。

12. **物料档案不能直接改库存**：传 `current_stock` 会被明确拒绝，必须走单据。

---

## 五、前端页面操作路径（**按真实用户视角操作**）

小程序共 25 页。下面是每个页面的**真实调用序列**——请按顺序调用，模拟用户在这个页面上的实际操作，
而不是随便挑接口打。这样才测得到真实链路。

### 员工侧（出库员台账）

| 页面 | 真实调用序列 | 用户看到什么 |
|---|---|---|
| 首页 `index` | `warehouse.list` → `outbound.myNotice` | 顶部提示「你有 N 张出库单被驳回」 |
| 领料出库 `out/submit` | `warehouse.list` → `material.categories` → `material.list` → `outbound.submit` | 选仓库 → 选细分类 → 搜索/扫码选料 → 加入清单 → 填领料人用途 → 提交 |
| 出库历史 `out/history` | `outbound.list` | 单号、状态、时间 |
| 出库详情 `out/detail` | `outbound.detail` →（撤销时）`outbound.cancel` | 明细、撤销按钮 |

### 采购员侧

| 页面 | 真实调用序列 |
|---|---|
| 采购入库 `purchase/submit` | `warehouse.list` → `material.categories` → `material.list` → `supplier.list` →（无供应商时）`supplier.upsert` → `inbound.submit` |
| 采购历史 `purchase/history` | `inbound.list` |
| 采购详情 `purchase/detail` | `inbound.detail` → `inbound.updatePrice` |
| 库存流水 `purchase/ledger` | `material.list` → `stats.stockFlow` |

### 仓管员侧

| 页面 | 真实调用序列 |
|---|---|
| 仓管工作台 `storekeeper/dashboard` | `stats.overview` → `outbound.pendingCount` → `inbound.pendingCount` → `outbound.list` → `inbound.list` |
| 待确认单据 `storekeeper/pending` | `outbound.list` → `inbound.list` → `outbound.confirm`/`reject` → `inbound.confirm` |
| 全部流水 `storekeeper/orders` | `warehouse.list` → `stats.orderFlow` →（撤销时）`outbound.cancel`/`inbound.cancel` |
| 本仓库存 `storekeeper/stock` | `warehouse.list` → `stats.stockList` |

### 盘点（仓管 + 老板协作）

| 页面 | 真实调用序列 |
|---|---|
| 盘点任务 `check/list` | `check.list` → `stats.warehouseSummary` → `material.list` → `check.create` |
| 盘点录入 `check/submit` | `check.detail` → `check.submit` |
| 盘点详情 `check/detail` | `check.detail` →（老板）`check.review` |

### 老板侧

| 页面 | 真实调用序列 |
|---|---|
| 数据看板 `boss/dashboard` | `stats.overview` |
| 趋势分析 `boss/trend` | `stats.trend` |
| 库存台账 `boss/stock` | `stats.stockList` |
| 单据流水 `boss/orders` | `stats.orderFlow` →（驳回）`outbound.reject` →（撤销）`inbound.cancel` |
| 库存预警 `boss/warning` | `stats.warning` |
| 我的 `my/profile` | `auth.myLogs` |

### Web 后台（`http://119.91.206.235:3000/admin/`，admin 账号）

后台是给管理岗用的，重点是：配件仓/成品仓两个独立菜单、细分类筛选、编号搜索、导出。
后台调用的也是同一批接口（`material.list` 带 `warehouse_id` + `sub_category`）。

---

## 六、测试纪律

1. **只碰【测试】物料**（见第一节铁律）。
2. **每条问题必须给证据**：原始请求（含 JSON body）+ 原始响应（完整返回）。没证据的结论标「推测」。
3. **状态与预期不符时，先回查确认再报**。你是和其他 3 个岗位**同时在线**操作的，
   别人刚改了库存/单据状态很正常。先 `list`/`detail` 复查，再判断是不是 bug。
4. **不要报已知设计行为**（第四节 12 条）。若你觉得某条设计不合理，可以写进「设计建议」，**不要当缺陷**。
5. **测试用的单据保留**，不要为了"干净"去删。清理由专门的脚本统一做。
6. 严重度判定：
   - **P0**：数据会算错、权限失效（越权能成功）、系统卡死无法自救
   - **P1**：核心作业要绕路、容易做错、提示误导
   - **P2**：能用但别扭、文案不清、交互不顺
7. 不要凭猜测写 SQL 直连数据库改数据。所有验证走接口。

---

## 七、汇报格式（**必须严格遵守**）

每个 Agent 交付一份 Markdown，结构如下：

```markdown
# <岗位> 测试报告（<姓名>）

## 一、我做了什么
逐轮列出：第 1 轮、第 2 轮、第 3 轮各做了哪些操作（含单号）。

## 二、我遇到的问题
### [P0] 一句话标题
- **现象**：我点了什么，看到了什么
- **原始请求**：`{"action":"...","data":{...}}`
- **原始响应**：`{"code":...,"message":"...","data":...}`
- **预期**：我认为应该怎样（依据是什么）
- **独立复查**：我重新查询后看到的状态
- **证据强度**：实证 / 推测

（P1、P2 同格式，可简写）

## 三、设计建议（不算缺陷）
...

## 四、我这个岗位愿不愿意继续用/敢不敢签字
（必须明确表态，允许答"不愿用"，并说明理由）

## 五、我做过的关键操作清单（供对账）
| 时间 | 操作 | 单号 | 影响 |
```

---

## 八、环境上下文

- 测试物料当前库存：火花塞 A型 90 / 点火线圈 B型 80 / 刹车片 C型 46 / 机油滤芯 D型 60 / 空气滤芯 E型 30 / 轴承 F型 40
- 待处理单据：出库单 2 张（火花塞×10、刹车片×4，待确认）、入库单 1 张（机油滤芯×60，待确认）
- 完整上下文（含 token、物料 _id）见同目录 `audit-context.json`
