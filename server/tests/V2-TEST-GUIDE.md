# 真实使用者测试 · 接口操作手册（流程重构 V2 版）

> 给「扮演真实岗位人员」的测试 Agent 用。你**不是**开发，你是这个系统的使用者。
> 你通过系统真实接口完成日常作业，然后如实汇报「哪些地方让你干不下去」。

---

## 〇、这一版和上一版最大的不同（必读）

系统刚做完「流程重构 V2」，**库存扣减的时机变了**，如果你按老印象操作会得出错误结论：

| 事项 | 老版本（已作废） | **V2（当前）** |
|---|---|---|
| 出库什么时候扣库存 | 提交那一刻就扣 | **领料员「确认收货」那一刻才扣** |
| 出库单有几个状态 | 待确认 / 已确认 | **待确认 → 待拣货 → 待收货 → 已完成** |
| 入库员这个岗位 | 有（`in`） | **没有了，已并入仓管员**（`storekeeper`） |
| 采购怎么走 | 采购员直接提交入库单 | **仓管发布采购任务 → 采购员领取并填实际单价 → 仓管收料入库** |
| 采购员的权限 | 能直接提交入库单 | **不能了**（`inbound.submit` 已收回给仓管） |

---

## 一、如何登录（拿身份）

先读 `server/tests/v2-test-context.json`，里面有 4 个岗位账号的账号、密码、以及**可直接使用的 `token`**。

```bash
# 登录（示例：领料员张三）
curl -s -X POST http://127.0.0.1:3000/api/auth \
  -H "Content-Type: application/json" \
  -d '{"action":"adminLogin","data":{"username":"zhangshan","password":"zs123456"}}'
```

返回里的 `data.token` 就是你的身份令牌，后续请求都带上：

```
-H "Authorization: Bearer <token>"
```

> token 有效期 7 天，测试期间不会过期。

---

## 二、所有请求的统一格式

```
POST http://127.0.0.1:3000/api/{模块名}
Content-Type: application/json
Authorization: Bearer <token>

{
  "action": "动作名",
  "data": { ... 参数 ... },
  "client_request_id": "可选，用于防重复提交"
}
```

统一返回：

```json
{ "code": 0, "data": { ... }, "message": "提示语" }
```

`code = 0` 表示成功；非 0 表示业务失败，`message` 是给用户看的提示语。
**`message` 是给普通员工看的，请你评判它是否说人话、员工看不看得懂。**

---

## 三、可用动作清单

### auth（登录/身份）
| 动作 | 参数 | 谁能用 |
|---|---|---|
| `adminLogin` | `username`, `password` | 所有人 |
| `getUserInfo` | — | 登录后 |
| `updateProfile` | `real_name`, `phone` | 登录后 |
| `changePassword` | `old_password`, `new_password` | 登录后 |

### material（物料）
| 动作 | 参数 | 谁能用 |
|---|---|---|
| `list` | `keyword`, `category`, `sub_category`, `warehouse_id`, `showWarningOnly`, `page`, `pageSize` | 所有人 |
| `detail` | `id` | 所有人 |
| `upsert` | `_id`(改)/无(增), `name`, `spec`, `unit`, `category`, `sub_category`, `warehouse_id`, `warning_stock` | 仓管/老板/管理员 |
| `import` / `delete` | — | 老板/管理员 |
| `categories` | `warehouse_id` | 所有人 |

> `keyword` 若是**完整物料编号**会精确命中；否则按 名称/规格/分类/细分类/编号/条码 模糊搜。

### outbound（出库 ★ V2 四阶段）
| 动作 | 参数 | 谁能用 | 状态变化 |
|---|---|---|---|
| `submit` | `warehouse_id`, `type`, `remark`, `items[]` | 领料员/采购/仓管/老板/管理员 | → `pending` **不扣库存** |
| `confirm` | `id` | 仓管/老板/管理员 | `pending` → `picking` |
| `pickDone` | `id` | 仓管/老板/管理员 | `picking` → `receiving` |
| `receive` | `id` | 领料员/采购/仓管/老板/管理员 | `receiving` → `completed` **★此刻扣库存** |
| `reject` | `id`, `reason` | 仓管/老板/管理员 | `pending`/`picking`/`receiving` → `rejected` |
| `cancel` | `id`, `reason` | 见下 | → `cancelled` |
| `list` | `status`, `type`, `warehouse_id`, `keyword`, `startDate`, `endDate`, `page` | 登录后（按仓库范围） | — |
| `detail` | `id` | 登录后 | — |
| `pendingCount` / `pickingCount` / `myNotice` | — | 登录后 | — |

- `items[]` 每项：`material_id`, `material_name`, `material_spec`, `unit`, `quantity`
- **`cancel` 的规则**：`pending`/`picking`/`receiving` 谁都能撤；`completed` **只有管理员能撤**（会回补库存）
- `type` 可选：`lingyong` 领用 / `xiaoshou` 销售 / `baofei` 报废 / `zengpin` 赠品 / `repair` 维修 / `tiaozheng` 调整
  （V2 里**领料员默认只做「领用」**，请以你的岗位职责为准）
- `myNotice` 会返回 `receiving_count` / `receiving_list`（待你收货的单）

### inbound（入库）
| 动作 | 参数 | 谁能用 |
|---|---|---|
| `submit` | `warehouse_id`, `type`(purchase/other), `supplier`, `remark`, `items[]` | **仓管/老板/管理员**（V2 已收回，采购员不能用） |
| `list` / `detail` | `status`, `warehouse_id`, `page` | 登录后 |
| `updatePrice` | `id`, `items[].material_id`, `items[].unit_price` | 老板/管理员/仓管 |
| `confirm` | `id` | 仓管/老板/管理员 |
| `cancel` | `id` | 提交人 |

### purchase（采购任务 ★ V2 全新）
| 动作 | 参数 | 谁能用 | 说明 |
|---|---|---|---|
| `create` | `warehouse_id`, `items[{material_id, quantity}]`, `assignee_openid`(选填), `remark` | 仓管/老板/管理员 | 不指定人 = 全体采购员可领 |
| `list` | `status`, `warehouse_id`, `keyword`, `page`, `pageSize` | 按角色收敛 | 采购员只看「自己领的 + 可领的」 |
| `detail` | `id` | 登录后 | 返回 `items[]` 含 `unit_price` |
| `take` | `id` | 采购员/老板/管理员 | `open` → `taken`，**并发抢单只有一个能成功** |
| `entry` | `id`, **`purchase_channel`**, `external_no`, `receipt_fileid`, `remark`, `items[{material_id, unit_price}]` | 采购员/老板/管理员 | `taken` → `purchased` |
| `receive` | `id` | 仓管/老板/管理员 | `purchased` → `received` **★此刻加库存 + 生成入库单** |
| `rejectBack` | `id`, **`reason`（必填）** | 仓管/老板/管理员 | `purchased` → 退回 `taken`，采购员要重填 |
| `cancel` | `id`, `reason` | 仓管/老板/管理员 | 已入库/已取消的不能取消 |
| `myTodoCount` / `assignees` | — | 登录后 | 待办数 / 启用中的采购员名单 |

**采购状态**：`open` 待领取 → `taken` 采购中 → `purchased` 待收料 → `received` 已入库（→ `cancelled` 已取消）
**购买方式只能是**：`淘宝` / `京东` / `线下` / `其他`

> ⚠️ **实际单价由采购员在 `entry` 时逐项填写**（系统里**没有**「预期单价」这个东西）。
> 仓管收料时系统按这些单价算这批货的入库成本。

### message（消息中心 ★ V2 全新）
| 动作 | 参数 | 说明 |
|---|---|---|
| `list` | `page`, `pageSize`, `only_unread` | 只能看到发给自己的；返回里带 `unread` 未读数 |
| `unreadCount` | — | 未读数（首页红点） |
| `markRead` | `id` | 单条已读 |
| `markAllRead` | — | 全部已读 |

### check（盘点）
| 动作 | 参数 | 谁能用 |
|---|---|---|
| `create` | `warehouse_id`, `type`, `scope:{material_ids:[], categories:[]}`, `freeze_stock`, `assignee_openids`, `remark` | 仓管/老板/管理员 |
| `list` / `detail` | `status`, `warehouse_id`, `page` | 登录后 |
| `submit` | `id`, `items[]`(`material_id`, **`actual_stock`**) | 登录后（无角色限制） |
| `review` | `id`, **`approve`**(true/false), `remark` | 老板/管理员 |
| `cancel` | `id` | 老板/管理员 |

> ⚠️ 字段名别记错：实盘数是 **`actual_stock`**；审核参数是 **`approve`**；范围是 **`scope.material_ids`**。
> `scope` 传空数组 = 整仓盘点。**`remark` 传入后不会保存（已知缺陷）。**

### stats（统计）
| 动作 | 说明 | 谁能用 |
|---|---|---|
| `overview` | 首页总览 | 老板/仓管/管理员 |
| `trend` | 出入库趋势 | 仅老板/管理员 |
| `stockList` | 库存台账 | 老板/仓管/领料/采购 |
| `orderFlow` | 单据流水 | 老板/仓管/**采购**/管理员 |
| `warning` | 库存预警 | 老板/仓管/采购 |
| `stockFlow` | 库存变动流水 | 老板/仓管/**采购**/管理员 |
| `materialRank` | 物料排行 | 老板/管理员 |
| `operatorStats` | 操作员统计 | 老板/管理员 |
| `warehouseSummary` | 仓库汇总（含库存总值） | 除管理员外全部角色 |

### 其他
- **supplier**：`list` / `detail` / `search` / `upsert`(仓管也可) / `delete`(老板/管理员)
- **user**（仅老板/管理员）：`list` / `detail` / `approve` / `updateRole` / `disable` / `enable` / `create` / `update` / `resetPassword` / `pendingCount` / `logs`
- **warehouse**：`list`（所有人）/ `upsert`（老板/管理员）
- **upload**：`upload` / `delete`

---

## 四、几条必须先知道的系统语义

1. **库存变动的时机（V2 最重要的一条）**
   - **出库**：提交、确认、拣货完成**都不动库存**；只有领料员（或代他）**确认收货**时才扣
   - **采购**：只有仓管**收料入库**时才增加库存，并同时生成一张「已确认」的入库单
   - **驳回 / 作废**：系统按单据上的「是否已扣过库存」标记决定要不要回补，不会重复扣也不会漏回补
2. **仓库数据权限**：你的账号被限定了可管仓库，操作别的仓会返回**「无操作权限」或空列表**——
   这是**正常的权限设计**，不是你被系统卡住，也不算缺陷（但如果你觉得权限配得不合理，可以作为「体验问题」提出来）
3. **防重复提交**：同一个 `client_request_id` 提交两次，第二次不会重复生效
4. **`_id` 就是主键**，返回里的 `_id` 要原样用于后续请求
5. **多仓库**：配件仓 = `peijian` 或 `1`；成品仓 = `chengpin` 或 `2`
6. **⚠️ 消息为什么收不到（这是测试环境的限制，不是功能坏了）**
   本轮 4 个岗位账号是**用账号密码登录的，没有 openid**，而站内消息是按 openid 投递的，
   收件人为空时服务端会静默不发。所以在这几个账号下消息中心必然是空的。
   想验证消息功能，请改用**有 openid 的 `dev_*` 账号**：登录方式
   `{"action":"login","data":{"dev_openid":"dev_out"}}`（`dev_out` 领料员 / `dev_sk` 仓管）。
   ⚠️ 但这里有个**真隐患**：给无 openid 的收件人发消息时，接口仍回复「已通知领料员来收货」——
   提示语与实际不符，在生产（全员微信登录、都有 openid）不会触发，但值得记下来。

---

## 五、测试纪律（务必遵守）

### 可以做的
- 用你的岗位账号，按你的日常工作习惯走完整流程
- 读代码来判断「我这个岗位在界面上看到什么、点什么」——小程序页面在
  `miniprogram/src/pages/`，**后台页面在 `admin/src/views/`**
- 故意做错事（填错、少填、重复提交、越权尝试），看系统怎么反应
- 看返回的 `message` 是否说人话

### 不能做的
- **不要修改任何代码**（你是使用者，不是开发）
- **只操作名称以「【测试】」开头的物料**（共 7 个，见 `v2-test-context.json`）
  ——另外一千多条是公司真实物料，只能查、不能改、不能出入库
- 不要删除/修改别人的待确认单据（除非你的岗位职责就是审批它们）
- 不要 `docker` 命令、不要重启服务、不要直接连数据库

### 记录问题时必须给证据
每条问题都要有：**你做了什么（可复现的原始请求）→ 系统返回了什么（原始响应）→ 为什么这让你干不下去**。
返回里出现严重问题时，保留原始 JSON。没有证据的猜测标为「推测」。

---

## 六、每个岗位必须额外做的一件事：后台一致性检查

**这是本轮测试的重点之一。** 老板反馈过：**后台看到的和自己在小程序里做的不一致**。

所以每轮结束时，你必须回答：

1. **同一个数据，在「后台」和「小程序」两条路径上取，结果一样吗？**
   后台用管理员账号（`adminLogin`，账号密码见 `v2-test-context.json` 里由管理员提供的凭据，
   或直接找测试组织者要）登录取 token，调用同样的模块/动作，逐字段比对。
   重点比：**条数、库存数值、单据状态**。
2. **读 `admin/src/views/` 的页面代码，判断你这个岗位的新功能，后台到底有没有？**
   例如：后台的出库单页面能不能显示「待拣货 / 待收货」这两种状态？有没有「采购任务」这个页面？
   有没有「消息中心」？
   如果后台**没有**，就属于「后台与小程序不同步」类问题，请单独归类列出。

把你查到的写进汇报的单独一节：**「后台与小程序一致性」**。

---

## 七、汇报格式（必须照此输出）

```markdown
# 【岗位】{姓名} · 3 轮真实使用汇报

## 使用前提
（一句话：你负责什么、每天怎么干活）

## 第 1 轮：{这一轮你想干什么}
### 操作过程
（按顺序列出你实际发出的请求与结果，附原始响应关键片段）
### 遇到的问题
| 序 | 问题 | 严重度 | 证据（请求→响应） | 为什么干不下去 |
### 本轮结论
（能不能顺利完成？卡在哪？）

## 第 2 轮 / 第 3 轮
（同上）

## 后台与小程序一致性
（第六节要求的内容，逐条给证据）

## 严重问题汇总
### P0 致命（不修我没法用）
### P1 严重（很影响效率）
### P2 体验（能用但别扭）

## 我这个岗位愿不愿意继续用？为什么？
（真实表态，可以直接说「不愿用」）
```

**严重度判定标准**（别把小事都标 P0）：
- **P0**：数据会错 / 活干不完 / 有安全越权 / 流程断掉
- **P1**：每次都要绕路、要多记多算、容易出错但能补救
- **P2**：只是别扭、慢一点、不好看
