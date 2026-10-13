# 盛龙 ERP · 第三轮多岗位真实使用者测试手册（V3）

> 本轮与上一轮最大的不同：**全部用「模拟微信身份」登录**（服务端 `dev_openid` 直通，
> 不接真实微信 `code2session`）。上线时才换成真实微信登录。
> 好处：每个岗位都有 `openid`，**消息通知这类按 openid 投递的链路能真实测到**。

---

## 一、怎么进入系统

### 1.1 统一请求格式

所有接口都是 `POST /api/<模块名>`，信封固定：

```json
{ "action": "动作名", "data": { ... }, "client_request_id": "可选，幂等用" }
```

返回固定：

```json
{ "code": 0, "message": "成功提示", "data": { ... } }
```

`code != 0` 即失败，`message` 是给人看的中文原因。**允许失败的动作要用失败来验证**，不要跳过。

鉴权：`Authorization: Bearer <token>`。token 从登录拿。

### 1.2 登录（模拟身份）

```json
POST /api/auth   { "action": "login", "data": { "dev_openid": "dev_sk" } }
```

| 身份 | dev_openid | 角色 | 可管仓库 | 岗位 |
|---|---|---|---|---|
| 领料员 | `dev_out` | `["out"]` | [1] 配件仓 | 车间领料 |
| 仓管员 | `dev_sk` | `["storekeeper"]` | **[1,2] 配件仓 + 成品仓** | 收发货、盘点、采购发布 |
| 采购员 | `dev_purchase` | `["purchase"]` | [1,2] | 采购 |
| 老板 | `dev_boss` | `["boss"]` | [1,2] | 看板、审批 |
| 系统管理员 | 用账号密码：`POST /api/auth {action:"adminLogin", data:{username:"admin", password:"123456"}}` | `["admin","boss"]` | 全部 | 后台管理 |

> ⚠️ 后台管理账号**没有 openid**，所以 `message.*` 对他永远返回空列表 —— 这是设计如此，**不是 bug**。
> 消息中心要用上面前 4 个模拟身份测。

上下文文件 `tests/v3-test-context.json` 里已经有各身份的 token、物料 ID、单号，可直接读。

### 1.3 仓库

| id | 名称 | 说明 |
|---|---|---|
| 1 | 配件仓 | 测试物料 5 个在这里 |
| 2 | 成品仓 | 测试物料 2 个在这里 |

**配件仓和成品仓由同一个仓管员（`dev_sk`）管**，所以他能同时操作两个仓。

---

## 二、必须先记住的业务语义（写错前提 → 报假问题）

### 2.1 出库单：4 个状态，**库存在「确认收货」那一刻才扣**

```
pending(待确认) --仓管 confirm--> picking(待拣货) --仓管 pickDone--> receiving(待收货) --领料员 receive--> completed(已完成)
                                                                                              ↑
                                                                                        【此刻扣库存】
```

- `submit` 提交**不动库存**
- 只有走到 `receive`（确认收货）才真正扣减，扣完 `stock_deducted = 1`
- 撤销（`cancel`）在 `pending`（10 分钟内）/`picking` 阶段可自撤；**`receiving` 阶段领料员不能撤**（货已拣完正在交接），
  但仓管 / 老板 / 管理员可以撤；`completed` 只有管理员能作废（会回补库存）

### 2.2 采购任务：4 个状态

```
open(待领取) --采购员 take--> taken(采购中) --采购员 entry--> purchased(待收料) --仓管 receive--> received(已入库)
                                                            ↑                      |
                                                            └── 仓管 rejectBack ───┘  （退回采购员重填）
```

- `receive` 收料入库时会**自动生成一张入库单**（`inbound_order_no`）并**加库存**
- 每项 `unit_price` **必须 > 0**（填 0 / 漏填 / 文字都要被拒），因为入库成本按它算
- `purchase_channel` 只能是：`淘宝` / `京东` / `线下` / `其他`（**中文**，传 `taobao` 会被拒）

### 2.3 直接入库单：**提交即加库存**（与出库相反！）

```
submit --（此刻已加库存）--> pending(待确认) --confirm--> confirmed(已确认，只改状态)
```

- 采购入库必须填 `supplier`（供应商）
- 提交时若发现库存不够，会报「库存不足：xxx 当前库存 N，本次需 M」
- 作废（`cancel`）会回退库存；若这批货已被领用导致库存不足，**不允许作废**

### 2.4 盘点单

```
create(创建，状态 draft) --录入 submit--> pending_review(待审核) --老板 review--> completed(差异已调整库存)
                                                        ↑                     |
                                                        └──── 退回可重录 ──────┘
```

- 审核必须**明确表态**：`approve: true` 才算通过；不传 / 传 `"yes"` / 传 2 都按「没表态」拦下
- 同一物料不能同时存在于两张未完成的盘点单

### 2.5 数据权限（仓库范围）

所有查询按**可管仓库**自动收敛。`dev_sk` 管 [1,2]，`dev_out` 只管 [1]。
自己仓库范围外的单据，访问应该报「无权」——这是**正确行为**，要验证而不是报 bug。

---

## 三、接口清单与权限

未标权限的 action（如 `list` / `detail`）表示**不做角色限制**，但数据范围仍受仓库权限约束。

| 模块 | action | 允许的角色 | 备注 |
|---|---|---|---|
| **auth** | `login` `adminLogin` | 公开 | |
| | `register` `updateProfile` `getUserInfo` `changePassword` `myLogs` | 登录用户 | |
| **material** | `list` `detail` `categories` | 所有登录用户 | `list` 支持 keyword/warehouse_id/page |
| | `upsert` | boss / admin / storekeeper | |
| | `import` `delete` | boss / admin | |
| **outbound** | `list` `detail` | 登录用户 | |
| | `submit` | out / purchase / storekeeper / boss / admin | 纯领料员只能提 `type:'lingyong'` |
| | `confirm` | storekeeper / boss / admin | |
| | `pickDone` | storekeeper / boss / admin | |
| | `receive` | out / purchase / storekeeper / boss / admin | 单据本人或仓管 |
| | `reject` | storekeeper / boss / admin | 必须填 `reason` |
| | `cancel` | 见 2.1 | |
| | `pendingCount` `pickingCount` `myNotice` | 登录用户 | |
| **inbound** | `submit` `confirm` `updatePrice` | storekeeper / boss / admin | `updatePrice` 已确认的单要 boss/admin |
| | `list` `detail` `cancel` `pendingCount` | 登录用户 | |
| **purchase** | `create` | storekeeper / boss / admin | 可 `assignee_openid` 指定采购员 |
| | `take` `entry` | purchase / boss / admin | `entry` 只能领取人本人 |
| | `receive` `rejectBack` `cancel` | storekeeper / boss / admin | `rejectBack` 必填 `reason` |
| | `list` `detail` `myTodoCount` `assignees` | 登录用户 | |
| **check** | `create` `submit` `cancel` | storekeeper / boss / admin | |
| | `review` | boss / admin | |
| | `list` `detail` | 登录用户 | 仓管可见本仓全部；其他角色只看自己创建/被指派的 |
| **stats** | `overview` | boss / admin / storekeeper | |
| | `trend` `materialRank` `operatorStats` | boss / admin | |
| | `stockList` `warehouseSummary` | boss/admin/storekeeper/out/purchase | |
| | `orderFlow` `warning` `stockFlow` | boss/admin/storekeeper/**purchase** | 采购员要月底对账，已放开只读 |
| **user** | `list` `detail` `approve` `updateRole` `disable` `enable` `create` `update` `resetPassword` `pendingCount` `logs` | boss / admin | |
| **supplier** | `list` `detail` `search` | 登录用户 | |
| | `upsert` | boss/admin/purchase/storekeeper | |
| | `delete` | boss / admin | |
| **warehouse** | `list` | 登录用户 | |
| | `upsert` | boss / admin | |
| **message** | `list` `unreadCount` `markRead` `markAllRead` | 登录用户（按 openid 隔离） | 参数是 **`only_unread`** |

### 关键入参速查

```jsonc
// outbound.submit
{ "warehouse_id": 1, "type": "lingyong", "remark": "…",
  "items": [ { "material_id": 12, "material_name": "…", "quantity": 5, "warehouse_id": 1 } ] }

// outbound.confirm / pickDone / receive / cancel   →  { "id": 608 }
// outbound.reject                                  →  { "id": 608, "reason": "…" }

// inbound.submit  （提交即加库存）
{ "warehouse_id": 1, "type": "purchase", "supplier": "供应商名",
  "items": [ { "material_id": 12, "material_name": "…", "quantity": 20, "unit_price": 12.5 } ] }
// inbound.confirm → { "id": … } ；inbound.updatePrice → { "id": …, "items": [ { "material_id", "unit_price" } ] }

// purchase.create
{ "warehouse_id": 1, "assignee_openid": "dev_purchase", "remark": "…",
  "items": [ { "material_id": 12, "quantity": 20 } ] }
// purchase.entry
{ "id": 301, "purchase_channel": "淘宝", "external_no": "TB-123",
  "items": [ { "material_id": 12, "quantity": 20, "unit_price": 12.5 } ] }
// purchase.take / receive / cancel → { "id": … } ；purchase.rejectBack → { "id": …, "reason": "…" }

// check.create
{ "type": "full", "warehouse_id": 2, "scope": { "material_ids": [12, 13] },
  "freeze_stock": false, "remark": "…" }
// check.submit → { "id": …, "items": [ { "material_id": 12, "actual_stock": 48, "remark": "" } ] }
// check.review → { "id": …, "approve": true, "remark": "通过" }

// stats
{ "action": "overview" }                       // 看板 KPI
{ "action": "warning", "data": { "page": 1, "pageSize": 20 } }        // 库存预警
{ "action": "stockFlow", "data": { "material_id": 12 } }               // 某物料流水
{ "action": "orderFlow", "data": { "page": 1 } }                       // 单据流水
{ "action": "stockList", "data": { "warehouse_id": 2, "page": 1 } }
{ "action": "trend", "data": { "days": 7 } }

// message.list → { "only_unread": true, "page": 1, "pageSize": 20 }

// ⚠️ 分页参数名是 **pageSize**（驼峰），不是 page_size！
//    传 page_size 不报错、但会被静默忽略 → 永远只返回 20 条，
//    会让你误判成「数据少了一半」。这条是上一轮手册的笔误，本轮已修正。
//    同理：盘点录入的实盘数量字段是 **actual_stock**（不是 actual_quantity）。
// message.markRead → { "id": 143 }   markAllRead → {}
```

---

## 四、各流程的真实调用序列（照这个顺序做，才是真实用户路径）

| 场景 | 前端页面 | 真实调用顺序 |
|---|---|---|
| **领料员提单** | `pages/out/submit` | `warehouse.list` → `material.categories` → `material.list`（按仓库/分类/关键词）→ `outbound.submit` |
| **领料员收自己的货** | `pages/out/list`（我的单） | `outbound.list` → `outbound.detail` → `outbound.receive` |
| **仓管工作台** | `pages/storekeeper/dashboard` | `stats.overview` → `outbound.pendingCount` → `outbound.pickingCount` → `inbound.pendingCount` → `outbound.list` → `inbound.list` |
| **仓管处理出库** | 同上 → 单据详情 | `outbound.detail` → `outbound.confirm` → `outbound.pickDone` →（需要时）`outbound.reject` |
| **仓管直接入库** | `pages/in/submit` | `material.list` → `inbound.submit` →（复核）`inbound.detail` → `inbound.confirm` |
| **仓管发布采购任务** | `pages/purchase/tasks`（仓管视角） | `purchase.assignees` → `material.list` → `purchase.create` |
| **采购员领任务并录入** | `pages/purchase/tasks` | `purchase.list` → `purchase.detail` → `purchase.take` → `purchase.entry` |
| **仓管收料入库 / 退回** | `pages/purchase/tasks` | `purchase.list` → `purchase.detail` → `purchase.receive` 或 `purchase.rejectBack` |
| **盘点** | `pages/check/*` | `check.create` → `check.detail` → `check.submit` →（老板）`check.review` |
| **老板看板** | `pages/boss/dashboard` | `stats.overview` → `stats.warehouseSummary` → `stats.trend` → `stats.warning` |
| **消息中心** | `pages/message/list` | `message.list` → `message.markRead` → `message.unreadCount` |
| **首页** | `pages/index/index` | `warehouse.list` → `outbound.myNotice` → `message.unreadCount` |
| **后台管理** | `/admin/`（Vue 端） | 与小程序**同一套接口**（`/api/*`），所以后台能做的，接口层必须一致 |

---

## 五、本轮待办（`tests/v3-test-context.json` 里有 ID）

| 岗位 | 待办 |
|---|---|
| 领料员 `dev_out` | 待收货单 `OUT-20261003-018`（`receiving`，等他确认收货） |
| 仓管员 `dev_sk` | 待确认 `OUT-20261003-016`、待拣货 `OUT-20261003-017`、待收料 `CG-20261003-013`、盘点单 `CHK-20261003-004`（draft） |
| 采购员 `dev_purchase` | 待领取 `CG-20261003-011`、采购中 `CG-20261003-012`（等他录入采购信息） |
| 老板 `dev_boss` | 等盘点提交后审批 |

测试物料（全部带 `【测试】` 前缀，与真实数据严格隔离）：

| key | 名称 | 仓库 | 当前库存 | 预警阈值 |
|---|---|---|---|---|
| SPK_A | 【测试】火花塞 A型 | 1 | 85 | 20 |
| COIL_B | 【测试】点火线圈 B型 | 1 | 54 | 15 |
| BRK_C | 【测试】刹车片 C型 | 1 | 15 | 5 |
| OIL_D | 【测试】机油滤芯 D型 | 1 | 39 | 30 |
| AIR_E | 【测试】空气滤芯 E型 | 1 | 35 | 30 |
| BRG_F | 【测试】轴承 F型 | 2 | 50 | 10 |
| GEAR_G | 【测试】齿轮 G型 | 2 | 24 | 8 |

---

## 六、测试纪律（必须遵守）

1. **只碰 `【测试】` 前缀的物料和自己新建的单据**。不要改、不要删任何非测试数据。
2. **只建带标记的单据**：`remark` 里必须包含你的轮次标记（第 1 轮 `[V3-R1]`、第 2 轮 `[V3-R2]`、第 3 轮 `[V3-R3]`），
   方便事后清理。第 2 轮故意做错的那些，**做错后要收拾干净**（撤销/作废掉，别留脏数据）。
3. **5 个岗位同时在线操作**。看到状态和你预期不一样时，**先回查确认**（重新 `detail` 看一眼、
   看 `message.list` 有没有别人给你的通知），不要立刻当成 bug —— 很可能别人刚动过。
   但**如果你确认是系统自己错了**，一定要报，并附上原始请求 + 原始响应。
4. **每条问题必须带证据**：原始请求报文 + 原始响应报文。没有证据的只能标「推测」。
5. 严重度自评标准：
   - **P0**：数据会算错 / 权限失效（能越权干不该干的事）/ 用户无法自救（流程卡死）
   - **P1**：能绕过去但容易错，或提示文案误导人
   - **P2**：别扭、不顺手，但能干活
6. **不要报这些「假问题」**：
   - 管理员账号收不到消息（无 openid，设计如此）
   - 访问别的仓库的单据被拒（数据权限，正确行为）
   - 重复提交被拦（幂等，正确行为）
7. 报「做对了的地方」也很重要 —— 否则整改时会误伤好设计。

---

## 七、汇报格式（必须照这个写）

```markdown
# <岗位名> Agent 测试汇报（第 N 轮）

## 一、我干了什么
（按时间顺序列，每条写：动作 → 单号/ID → 结果）

## 二、我报的问题
### [P0/P1/P2] 一句话标题
- 我做了什么（原始请求）
- 系统回了什么（原始响应，贴关键字段）
- 我认为哪里不对 / 应该是什么样
- 有没有证据（有证据 / 推测）

## 三、系统做对的地方
（列 3-8 条）

## 四、我这个岗位愿不愿意继续用 / 敢不敢签字
（必须明确回答；允许答「不愿意」，但要说明卡在哪）
```

---

## 八、已知环境限制（不是 bug，别当问题报）

- 服务跑在本机 `http://127.0.0.1:3000`，**未部署**，服务器与生产库本轮不动
- 上线相关的两件事**本轮不做**：真实微信登录（`WX_SECRET` 未配）、HTTPS 域名
- 模拟身份在**服务端 `ALLOW_DEV_LOGIN=true`** 时可用；生产会关掉
