# 领料员张三 Agent 测试汇报（第 3 轮）

> 身份：`dev_out`（openid `dev_out`，角色 `["out"]`，可管仓库 `[1] 配件仓`），42 岁车间领料员 张三。
> 本轮主题：**权限边界 + 追责对账**。环境：`http://127.0.0.1:3000`（未重启、未改代码）。
> 所有请求走 `node` 脚本（`node` + `fetch`，UTF-8），原始请求/响应落盘于 `.tmp-local-audit/out-r3/raw/`。

---

## 一、我干了什么（按时间顺序）

| # | 动作 | 对象 | 结果 |
|---|---|---|---|
| 1 | `auth.login` 自检 | dev_out / dev_worker_01 / dev_sk | 全部 code=0；worker_01 角色 `["out","storekeeper","purchase"]` 仓库 `[1,2]` |
| 2 | 权限矩阵：逐个调 31 个「不该我做」的 action | 见下表 | **31/31 被拒**，无一条越权成功 |
| 3 | 正面验证：`warehouse.list` / `material.list` / `stats.stockList` / `message.list` / `outbound.list` | 配件仓 | 全 code=0，数据收敛到仓库 1 |
| 4 | `stats.warning`（手册不含 out） | — | code=403 无操作权限 |
| 5 | `outbound.submit type=报废`（纯 out） | — | code=403：「领料员只能提交「领用」类型的出库单…」 |
| 6 | 多角色叠加：worker_01 提 **报废** 单 | OUT-20261003-031 | code=0 成功 → 已自撤清理 |
| 7 | 多角色叠加：worker_01 `outbound.confirm` | OUT-20261003-031 | code=0 成功（storekeeper 角色生效） |
| 8 | 多角色叠加：worker_01 `stats.overview` | — | code=0（out 单独被拒？否 —— 见问题3备注，out 被拒） |
| 9 | 多角色叠加：worker_01 `purchase.create`→`take` | CG id=19 | code=0 成功（purchase 角色生效）→ 已取消清理 |
| 10 | 数据边界：`material.list {warehouse_id:2}` | 成品仓 | code=0 但返回 **0 条**（静默收敛，无泄漏） |
| 11 | 数据边界：`stats.stockList {warehouse_id:2}` | 成品仓 | code=0 返回 0 条；不带仓时只出仓库 1 的数据 |
| 12 | 数据边界：`outbound.list` 全量 | 19 条 | **全部 `operator_openid=dev_out`、全部 `warehouse_id=1`**，看不到别人的单 / 成品仓的单 |
| 13 | 数据边界：`outbound.detail` 别人的单 | OUT-20261003-030 | code=403「只能查看自己提交的单据」 |
| 14 | 数据边界：`outbound.receive` 别人的单（代收货） | OUT-20261003-030 | code=403「只有该单的领料人或仓管可以确认收货」 |
| 15 | 数据边界：`outbound.submit warehouse_id=2` | 成品仓 | code=403「你没有「出库单」所在仓库的操作权限…」 |
| 16 | 数据边界：`inbound.cancel` 别人的入库单 | IN-20261001-006 | code=403「只能查看自己提交的单据」 |
| 17 | 自身全流程：提 2 张 [V3-R3] 领用单 | OUT-20261003-033 / 034 | code=0 |
| 18 | `outbound.cancel`（pending 自撤） | OUT-20261003-034 | code=0「已作废（该单尚未扣库存，无需回补）」 |
| 19 | 仓管 `confirm` + `pickDone` | OUT-20261003-033 | code=0 |
| 20 | `outbound.cancel`（receiving 阶段自撤）| OUT-20261003-033 | **code=403**「货物已拣完正在交接，不能自行撤销，请联系仓管处理」✓ |
| 21 | `outbound.receive`（自己的单） | OUT-20261003-033 | code=0「已确认收货，库存已扣减」；物料 2104 库存 22→21 |
| 22 | 流水对账：`stats.stockFlow` 命中扣减 | OUT-20261003-033 | change=-1，operator=`开发·出库员(dev_out)`，22→21 ✓ |
| 23 | 清理：管理员作废已完成单 | OUT-20261003-033 | code=0「已作废，库存已回补」；库存回到 22 |
| 24 | 清理核验 | 我名下 [V3-R3] | 033/034/031 全部 `cancelled, deduct=0`，采购任务 19 已取消 |

---

## 二、权限矩阵表（本轮核心产出）

判据 = 手册第三节权限表。返回码为**业务码**（HTTP 均为 200，错误在 body 的 `code` 字段）。

### A-1 我「不该能做」的 31 个 action（dev_out）

| # | action | 返回码 | 是否被拒 | 是否符合手册预期 | 备注 |
|---|---|---|---|---|---|
| 1 | `outbound.confirm` | 403 | 被拒 | 符合（仅 storekeeper/boss/admin） | 无操作权限 |
| 2 | `outbound.pickDone` | 403 | 被拒 | 符合 | 无操作权限 |
| 3 | `outbound.reject` | 403 | 被拒 | 符合 | 无操作权限 |
| 4 | `inbound.submit` | 403 | 被拒 | 符合 | 无操作权限（提交即加库存，拦得住） |
| 5 | `inbound.confirm` | 403 | 被拒 | 符合 | 无操作权限 |
| 6 | `inbound.updatePrice` | 403 | 被拒 | 符合 | 无操作权限 |
| 7 | `inbound.cancel` | 404 → 403 | 被拒 | 符合（安全） | id=1：404「单据不存在」（该 action 无角色门，走 owner 校验）；换别人的真实单 IN-20261001-006 → 403「只能查看自己提交的单据」。out 无自己入库单 → 实际不可作废 |
| 8 | `purchase.create` | 403 | 被拒 | 符合 | 无操作权限 |
| 9 | `purchase.take` | 403 | 被拒 | 符合 | 无操作权限 |
| 10 | `purchase.entry` | 403 | 被拒 | 符合 | 无操作权限 |
| 11 | `purchase.receive` | 403 | 被拒 | 符合 | 无操作权限 |
| 12 | `purchase.rejectBack` | 403 | 被拒 | 符合 | 无操作权限 |
| 13 | `purchase.cancel` | 403 | 被拒 | 符合 | 无操作权限 |
| 14 | `check.create` | 403 | 被拒 | 符合 | 无操作权限 |
| 15 | `check.submit` | 403 | 被拒 | 符合 | 无操作权限 |
| 16 | `check.review` | 403 | 被拒 | 符合（仅 boss/admin） | 无操作权限 |
| 17 | `check.cancel` | 403 | 被拒 | 符合 | 无操作权限 |
| 18 | `user.list` | 403 | 被拒 | 符合 | 无操作权限 |
| 19 | `user.updateRole` | 403 | 被拒 | 符合 | 无操作权限（提权尝试被拦） |
| 20 | `user.disable` | 403 | 被拒 | 符合 | 无操作权限 |
| 21 | `user.create` | 403 | 被拒 | 符合 | 无操作权限 |
| 22 | `user.logs` | 403 | 被拒 | 符合 | 无操作权限 |
| 23 | `stats.operatorStats` | 403 | 被拒 | 符合（仅 boss/admin） | 无操作权限 |
| 24 | `stats.materialRank` | 403 | 被拒 | 符合（仅 boss/admin） | 无操作权限 |
| 25 | `stats.trend` | 403 | 被拒 | 符合（仅 boss/admin） | 无操作权限 |
| 26 | `material.upsert` | 403 | 被拒 | 符合 | 无操作权限 |
| 27 | `material.delete` | 403 | 被拒 | 符合 | 无操作权限（用不存在 id 探测，权限门先拦） |
| 28 | `material.import` | 403 | 被拒 | 符合 | 无操作权限 |
| 29 | `supplier.upsert` | 403 | 被拒 | 符合 | 无操作权限 |
| 30 | `supplier.delete` | 403 | 被拒 | 符合 | 无操作权限 |
| 31 | `warehouse.upsert` | 403 | 被拒 | 符合 | 无操作权限 |

**小计：31 次尝试 / 31 次被告知无权 / 0 次越权成功。**

### A-2 补充边界尝试（同为「不该能做」）

| action | 参数 | 返回码 | 是否符合预期 | 备注 |
|---|---|---|---|---|
| `outbound.submit` | `type:"报废"` | 403 | 符合（纯领料员只能 lingyong） | 文案清楚，后端硬拦 |
| `outbound.submit` | `warehouse_id:2` | 403 | 符合（数据范围） | 「你没有「出库单」所在仓库的操作权限」 |
| `outbound.detail` | 别人的单 620 | 403 | 符合 | 「只能查看自己提交的单据」 |
| `outbound.receive` | 别人的单 620 | 403 | 符合 | 「只有该单的领料人或仓管可以确认收货」 |
| `inbound.cancel` | 别人的单 | 403 | 符合 | 「只能查看自己提交的单据」 |
| `stats.warning` | — | 403 | 符合手册（手册不含 out） | 见问题 1 |

### A-3 我「应该能做」的（对照验证）

| action | 返回码 | 是否符合手册预期 | 备注 |
|---|---|---|---|
| `outbound.submit`（lingyong） | 0 | 符合 | OUT-20261003-033/034 |
| `outbound.list` | 0 | 符合 | 仅本人 19 条 |
| `outbound.detail`（自己的单） | 0 | 符合 | |
| `outbound.receive`（自己的单） | 0 | 符合 | OUT-20261003-033 收货成功并扣库存 |
| `outbound.cancel`（pending） | 0 | 符合 | OUT-20261003-034 自撤成功 |
| `material.list` | 0 | 符合 | |
| `stats.stockList` | 0 | 符合 | 不带仓时只出仓库 1 |
| `stats.warning` | **403** | **符合手册 / 与任务清单不符** | 手册第三节 warning 只给 boss/admin/storekeeper/purchase；见问题 1 |
| `message.list` | 0 | 符合 | 5 条，全部投给 dev_out |
| `warehouse.list` | 0 | 符合 | 返回 2 个仓（列表非敏感） |

### A-4 多角色叠加（`dev_worker_01` = out + storekeeper + purchase）

| 角色 | 验证动作 | 返回码 | 结论 |
|---|---|---|---|
| out | `outbound.submit type:"报废"` | **0（成功）** | 多角色账号可提报废；纯领料员被拒 → **同 action 按角色差异化放行，正确** |
| storekeeper | `stats.overview` | 0 | 通过（纯 out 被拒，多角色通过） |
| storekeeper | `outbound.confirm` | 0 | 通过 |
| storekeeper | `purchase.create` | 0 | 通过 |
| purchase | `purchase.take` | 0 | 通过 |

结论：多角色账号「三类事都能做」；关键点 **报废类型对多角色放行、对纯领料员拦截**，符合设计。

---

## 三、数据边界（追责相关）

| 检查项 | 结果 | 判定 |
|---|---|---|
| 能看到**别人提交**的出库单吗 | `outbound.list` 19 条，`operator_openid` 全部 = `dev_out`，非本人 0 条 | ✓ 正确隔离 |
| 能看到**成品仓**的单吗 | 列表 `warehouse_id` 全部 = 1；sk 视角全库 33 条中成品仓单 0 条（本无成品仓出库单） | ✓ 无可泄漏样本，但隔离逻辑生效 |
| `material.list {warehouse_id:2}` | code=0，返回 0 条 | ✓ 静默收敛（非报错，可接受） |
| `stats.stockList {warehouse_id:2}` | code=0，返回 0 条 | ✓ 同上 |
| 对**别人的单** `outbound.detail` | 403「只能查看自己提交的单据」 | ✓ 正确 |
| 对**别人的单** `outbound.receive`（代收货） | 403「只有该单的领料人或仓管可以确认收货」 | ✓ 正确 |
| `outbound.submit` 到成品仓 | 403「你没有「出库单」所在仓库的操作权限」 | ✓ 正确 |

---

## 四、追责对账：能不能一笔笔还原？——**能**

### 4.1 我经手的已完成单（[V3-]）

| 单号 | 状态 | 扣减标志 | 明细 | 收货人 |
|---|---|---|---|---|
| OUT-20261003-021 | completed | 1 | 刹车片C×2、空气滤芯E×5 | 开发·出库员(dev_out) |
| OUT-20261003-018 | completed | 1 | 刹车片C×2、空气滤芯E×5 | 开发·出库员(dev_out) |
| OUT-20261003-017 | completed | 1 | 火花塞A×4、机油滤芯D×2 | 开发·出库员(dev_out) |
| OUT-20261003-033（本轮自测） | completed→已由管理员作废回补 | 1→0 | 空气滤芯E×1 | 开发·出库员(dev_out) |

> 说明：出库单字段里**没有 `total_amount`**（领用单不计金额，只有数量），故对账以「数量 + 库存流水」为准。

### 4.2 每笔出库 → 流水记录（单号一一对应）

| 单号 | 物料 | 应扣数量 | 流水命中 | 流水操作人 | before→after |
|---|---|---|---|---|---|
| OUT-20261003-021 | 2102 刹车片C | 2 | change=-2 ✓ | 开发·出库员(dev_out) | 13→11 |
| OUT-20261003-021 | 2104 空气滤芯E | 5 | change=-5 ✓ | 开发·出库员(dev_out) | 30→25 |
| OUT-20261003-018 | 2102 刹车片C | 2 | change=-2 ✓ | 开发·出库员(dev_out) | 15→13 |
| OUT-20261003-018 | 2104 空气滤芯E | 5 | change=-5 ✓ | 开发·出库员(dev_out) | 35→30 |
| OUT-20261003-017 | 2100 火花塞A | 4 | change=-4 ✓ | 开发·出库员(dev_out) | 95→91 |
| OUT-20261003-017 | 2103 机油滤芯D | 2 | change=-2 ✓ | 开发·出库员(dev_out) | 39→37 |
| OUT-20261003-033 | 2104 空气滤芯E | 1 | change=-1 ✓ | 开发·出库员(dev_out) | 22→21 |

**每一笔出库都能在 `stats.stockFlow` 里按单号找到扣减记录，且 `operator_name` = 我（确认收货人）。**

### 4.3 手算库存：初始 − 已出库 + 已入库 = 当前库存

以**全流水**（期初=最早一条的 `before_stock`）连续推演：

| 物料 | 期初 | Σ变动 | 期末 | 当前库存 | 是否对得上 |
|---|---|---|---|---|---|
| 2102 刹车片C | 0 | +11 | 11 | 11 | ✓ |
| 2104 空气滤芯E | 0 | +25 | 25 | 25 | ✓ |
| 2100 火花塞A | 0 | +91 | 91 | 91 | ✓ |
| 2103 机油滤芯D | 0 | +37 | 37 | 37 | ✓ |

- 4 张物料的流水链 `before_stock` / `after_stock` **首尾相接、无断点**；
- 每条流水的**期末 after_stock == material.detail 的 current_stock**；
- 抽查 OUT-20261003-033：收货前 22 → 收货后 21（-1，与数量一致）→ 管理员作废后回到 22。

**对账结论：能一笔笔还原。账实一致，无悬空扣减、无重复扣减、无漏记流水的现象。**

---

## 五、我报的问题

### [P2] 领料员查不到自己领料的库存流水，无法自助对账
- 我做了什么：`POST /api/stats {"action":"stockFlow","data":{"material_id":2102}}`
- 系统回了什么：`{"code":403,"message":"无操作权限"}`（`stats.warning` 同为 403）
- 我认为哪里不对 / 应该是什么样：手册第三节把 `orderFlow/warning/stockFlow` 限定为 `boss/admin/storekeeper/purchase`，**不含 out**，所以 403 与手册一致、不算 bug。但本轮「追责对账」暴露一个真实缺口：**领料员看不到自己领的料有没有扣、扣得对不对**，只能找仓管/老板代查。建议给领料员开放**只读且限定本人相关单号**的流水视图。
- 证据：有（`.tmp-local-audit/out-r3/raw/002_stats-stockFlow-out.json`；`004_stats-warning-out.json`）

### [P2] 历史脏数据：`pending` 却 `stock_deducted=1`
- 现象：`OUT-20261001-008(id=580)`、`OUT-20261001-004(id=576)` 状态 `pending`，但 `stock_deducted=1`
- 原始响应（detail）：`status=pending deduct=1 items=["2111x10"]` / `["2109x10"]`
- 我认为哪里不对：按手册 2.1，库存只在 `receive`（→completed）那一刻扣。`pending` 且已扣库存属于**状态与扣减标志自相矛盾**，对账时会被误判。**本轮新建的单行为正确**（pending/picking 单 `stock_deducted=0`，`receive` 后才 =1），判定为 **2026-10-01 的 E2E 残留数据**，建议清库或加一条一致性自检。
- 证据：有（`.tmp-local-audit/out-r3/raw/` 中对应 outbound-detail 响应 + `outbound-list-out.json`）

### [P2] `login(dev_openid:"admin")` 返回 code=0 但角色为空，易被误当管理员
- 我做了什么：`POST /api/auth {"action":"login","data":{"dev_openid":"admin"}}`
- 系统回了什么：`{"code":0,"message":"操作成功","data":{...,"openid":"admin","roles":[]}}`（无 `roles`）
- 我认为哪里不对：模拟登录接受任意 `dev_openid` 并签发 token，即使该身份不存在/无角色。我在清理时误用了这个 token，`outbound.cancel` 得到 `403 只能查看自己提交的单据`，一度以为是「管理员不能作废已完成单」。**仅测试环境（`ALLOW_DEV_LOGIN=true`）**，安全影响低；但建议未知 openid 直接拒绝登录，或登录返回里显著提示「该身份无任何角色」。
- 证据：有（`.tmp-local-audit/out-r3/raw/001_auth-adminLogin-out.json` 及对应 `auth-login` 响应）

> 本轮**没有 P0 / P1**。上面 3 条都是 P2（可用、但会误导或增加沟通成本）。

---

## 六、系统做对的地方

1. **31 项越权 action 全被稳定拦下**（统一 `403 无操作权限`），包括最容易出事的 `user.updateRole`（提权）、`material.delete`、`warehouse.upsert`，**无一条绕过**。
2. **数据隔离三层生效**：列表只出本人/本仓；越仓查询静默收敛为空；越仓提交与他人单据的 `detail`/`receive` 均 `403` 且文案准确。
3. **出库类型按角色硬拦**：纯领料员提 `报废` 被拒，多角色账号放行 —— 说明**后端是真正的门，前端置灰只是提示**。
4. **出库状态机 + 扣库存时机正确**：`submit/confirm/pickDone` 不动库存；`receiving` 阶段领料员不能自撤（403 文案清楚）；只有 `receive` 才扣减，`stock_deducted` 才置 1。
5. **库存流水无死角**：每笔出库都能按单号对上扣减记录，`operator` 记到具体收货人；流水链 `before/after` 连续，期末 == 当前库存，期初 0 + Σ变动 == 期末。
6. **作废回补正确**：管理员作废已完成单，库存精确回补（21→22），`stock_deducted` 归 0，并写操作日志。
7. **多角色叠加正确**：`out+storekeeper+purchase` 三类操作全通，且不因「有一个角色」而误放开另一角色的能力。

---

## 七、我这个岗位愿不愿意继续用 / 敢不敢签字

**愿意继续用，敢签字。**

理由：本轮把「不该我干的事」系统性试了一遍，**31 项越权全部被拦、0 越权成功**；数据边界清晰（看不到别人的单、看不到成品仓、代收货被拒）；我经手的账**能一笔笔还原**，账实一致。

但签字时我会附一个保留条件：**（1）** 请给我一个能查「我领的料」流水的只读入口——否则每次月底对账我都得去堵仓管；**（2）** 请把 `pending 却已扣库存` 的历史脏数据清掉，否则我自己对账会被这两张老单带偏。这两点解决前，日常领料没问题，**逐单签字对账**我会要求仓管在场复核。
