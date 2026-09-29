# 真实使用者测试 · 接口操作手册

> 给「扮演真实岗位人员」的测试 Agent 用。你**不是**开发，你是这个系统的使用者。
> 你通过系统真实接口完成日常作业，然后如实汇报「哪些地方让你干不下去」。

---

## 一、如何登录（拿身份）

所有岗位账号都用同一个接口登录。先读 `server/tests/user-test-context.json`，
里面有 4 个账号的账号、密码、以及可直接使用的 `token`。

```bash
# 登录（示例：出库员张三）
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
| `myLogs` | `page`, `pageSize` | 登录后 |

### material（物料）
| 动作 | 参数 | 谁能用 |
|---|---|---|
| `list` | `keyword`, `category`, `warehouse_id`, `showWarningOnly`, `page`, `pageSize` | 所有人 |
| `detail` | `id` | 所有人 |
| `upsert` | `_id`(改)/无(增), `name`, `spec`, `unit`, `category`, `warehouse_id`, `warning_stock` | 仓管/老板/管理员 |
| `categories` | — | 所有人 |

### outbound（出库）
| 动作 | 参数 | 谁能用 |
|---|---|---|
| `submit` | `warehouse_id`, `type`, `remark`, `items[]` | 出库员/采购/仓管/老板 |
| `list` | `status`, `type`, `page`, `pageSize` | 登录后（按角色返回范围） |
| `detail` | `id` | 登录后 |
| `cancel` | `id` | 提交人 |
| `confirm` | `id` | 仓管/老板/管理员 |
| `reject` | `id`, `reason` | **老板/管理员** |
| `pendingCount` | — | 登录后 |

`items[]` 每项：`material_id`, `material_name`, `material_spec`, `unit`, `quantity`

### inbound（入库）
| 动作 | 参数 | 谁能用 |
|---|---|---|
| `submit` | `warehouse_id`, `type`(purchase/other), `supplier`, `remark`, `items[]` | 入库员/采购/仓管/老板 |
| `list` / `detail` | 同上 | 登录后 |
| `updatePrice` | `id`, `items[].material_id`, `items[].unit_price` | 入库员/采购/仓管/老板/管理员 |
| `confirm` | `id` | 仓管/老板/管理员 |
| `cancel` | `id` | 提交人 |

`items[]` 每项：`material_id`, `material_name`, `material_spec`, `unit`, `quantity`, `unit_price`

### check（盘点）
| 动作 | 参数 | 谁能用 |
|---|---|---|
| `create` | `warehouse_id`, `type`, `scope:{material_ids:[], categories:[]}`, `freeze_stock`, `assignee_openids`, `remark` | 仓管/老板/管理员 |
| `list` / `detail` | `status`, `warehouse_id`, `page` | 登录后 |
| `submit` | `id`, `items[]`(`material_id`, **`actual_stock`**) | 登录后（**无角色限制**） |
| `review` | `id`, **`approve`**（true/false）, `remark` | 老板/管理员 |
| `cancel` | `id` | 老板/管理员 |

> ⚠️ 注意字段名：实盘数是 **`actual_stock`**（不是 `actual_quantity`），
> 审核参数是 **`approve`**（不是 `approved`），
> 盘点范围是 **`scope.material_ids`**（不是顶层 `items`）——
> `scope` 传空数组 = **整仓盘点**（配件仓 1764 项）。
> `remark` 传入后不会保存（已知缺陷）。

### stats（统计）
| 动作 | 说明 | 谁能用 |
|---|---|---|
| `overview` | 首页总览（今日出入库、库存、预警数） | 老板/仓管/管理员 |
| `trend` | 出入库趋势 | **仅老板/管理员** |
| `stockList` | 库存台账 | 老板/仓管/入库员/出库员/采购 |
| `orderFlow` | 单据流水 | 老板/仓管/管理员 |
| `warning` | 库存预警清单 | 老板/仓管/采购 |
| `stockFlow` | 库存变动流水（可追溯单据） | 老板/仓管/管理员 |
| `materialRank` | 物料排行 | 老板/管理员 |
| `operatorStats` | 操作员统计 | 老板/管理员 |
| `warehouseSummary` | 仓库汇总 | 除管理员外全部角色 |

### supplier（供应商）
`list` / `detail` / `search` / `upsert` / `delete`
`upsert` 参数：`_id`, `name`, `contact`, `phone`, `tax_no`, `address`, `payment_term`

### user（账号管理，仅老板/管理员）
`list` / `detail` / `approve` / `updateRole` / `disable` / `enable` / `create` / `update` / `resetPassword` / `pendingCount`

### warehouse（仓库）
`list`（所有人）/ `upsert`（老板/管理员）

---

## 四、几条必须先知道的系统语义

1. **库存变动的时机**
   - 出库/入库**提交的那一刻**库存就变了（出库减、入库加）
   - 「确认」「驳回」只改单据状态，**不动库存**
   - 「撤销」「驳回」会把库存**回补**
2. **防重复提交**：同一个 `client_request_id` 提交两次，第二次不会重复生效
3. **多仓库**：配件仓 = `peijian` 或 `1`；成品仓 = `chengpin` 或 `2`
4. **`_id` 就是主键**，返回里的 `_id` 要原样用于后续请求

---

## 五、测试纪律（务必遵守）

### 可以做的
- 用你的岗位账号，按你的日常工作习惯走完整流程
- 读代码来判断「我这个岗位在界面上看到什么、点什么」——小程序页面在
  `miniprogram/src/pages/`，后台页面在 `admin/src/views/`
- 故意做错事（填错、少填、重复提交、越权尝试），看系统怎么反应
- 看返回的 `message` 是否说人话

### 不能做的
- **不要修改任何代码**（你是使用者，不是开发）
- **只操作名称以「【测试】」开头的物料**（共 6 个，见 `user-test-context.json`）
  ——另外 1909 条是公司真实物料，只能查、不能改、不能出入库
- 不要删除/修改别人的待确认单据（除非你的岗位职责就是审批它们）
- 不要 `docker` 命令、不要重启服务、不要直接连数据库

### 记录问题时必须给证据
每条问题都要有：**你做了什么（可复现的原始请求）→ 系统返回了什么（原始响应）→ 为什么这让你干不下去**。
返回里出现严重问题时，保留原始 JSON。没有证据的猜测标为「推测」。

---

## 六、汇报格式（必须照此输出）

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
