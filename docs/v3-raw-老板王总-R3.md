# 老板·王总 Agent 测试汇报（第 3 轮）

> 主题：**权限边界 + 追责对账**
> 环境：本机 `http://127.0.0.1:3000`（未重启、未改任何代码）
> 身份：`dev_boss`（uid=29，roles `["boss"]`，可管仓库 [1,2]）
> 纪律：所有改数据的操作做完均已恢复；只用 `node` 脚本发请求（脚本在 `.tmp-local-audit/bossr3/`，原始报文在 `bossr3/raw/`）
>
> ⚠️ 测试中途 **服务进程自己退出了**（约 12:02Z，无异常堆栈）。按「不要重启」的纪律我**没有重启**，轮询约 5 分钟后服务由**其他岗位**恢复（12:07:44Z UP），随后继续完成。详见「附带说明」。

---

## 一、我干了什么

| # | 动作 | 对象/单号 | 结果 |
|---|---|---|---|
| 1 | `auth.login`（dev_boss/sk/out/purchase）| — | 4 个身份全部登录成功，老板 roles=`["boss"]` |
| 2 | `user.list` / `user.detail` / `user.logs` | 全量 16 个账号 | 老板可读，正常 |
| 3 | `stats.trend` / `materialRank` / `operatorStats` | days=7/30 | 全部 code=0，正常 |
| 4 | `warehouse.upsert`（原值回写）| 仓库#1 配件仓 | code=0「更新成功」，值未变（幂等验证，无脏数据）|
| 5 | `supplier.upsert` → `supplier.delete` | 新建 `[V3-R3]测试供应商_...`（#73）| 建/删均成功，已清理 |
| 6 | `material.import` → `material.delete` | 新建 `[V3-R3]测试导入物料_...`（#2117）| 导入成功；删除成功（软删），已清理 |
| 7 | `outbound.submit` → `confirm` → `cancel` | 自建 `OUT-20261003-036`（#626）| pending→picking→cancelled，库存未动，已清理 |
| 8 | `purchase.create` → `take` → `entry` → `cancel` | 自建 `CG-20261003-022`（#22）| open→taken→purchased→cancelled，已清理 |
| 9 | `check.review` 专项 | 盘点单 `CHK-20261003-006`（#170）| 见问题 P5；最终已按原意恢复为 `completed`（diff=0）|
| 10 | 老板 vs 管理员权力边界（A3）| admin#1 / 自建#53#54 / 自己#29 | 见「老板权力边界实测表」|
| 11 | 追责日志核验（A4）| `operation_logs` | 危险操作均有记录；抽 3 条回查对应模块真实数据，吻合 |
| 12 | 全库对账（B）| overview / warehouseSummary / stockFlow / orderFlow | 见「全库对账表」|
| 13 | 越权对照（C）| sk / out / purchase token 打 5 个管理接口 | 15 次调用全部被 403 拒绝 |

---

## 二、老板权力边界实测表（本轮核心）

> 全部用 **boss token**（`dev_boss`，**不是** admin token）发起。每项都记录返回，若真改动了就**立刻恢复**，并记「恢复前后的值」。

| 项 | 请求 | 原始响应 | 实际数据变化 | 是否被禁止 | 结论 | 恢复 |
|---|---|---|---|---|---|---|
| **P1 降级管理员** | `user.updateRole {id:1, roles:["out"]}` | `{code:0, message:"角色已更新"}` | admin#1 `["admin","boss"]` → `["out"]` | **否** | ❌ **危险：能改** | 已恢复：`approve{roles:["admin","boss"]}` → 回 `["admin","boss"]` |
| **P2 禁用管理员** | `user.disable {id:1}` | `{code:0, message:"已禁用该账号"}` | admin#1 `status: active` → `disabled` | **否** | ❌ **危险：能改** | 已恢复：`enable{id:1}` → 回 `active` |
| **P3 创建 admin 账号** | `user.create {roles:["admin"],...}` | `{code:0, data:{_id:54}, message:"账号创建成功"}` | 新增 #54，`roles:["admin"]`, active | **否** | ❌ **危险：能造管理员** | 已降级+禁用（#54 → `["out"]`/disabled）|
| **P4 approve 授予 admin** | `user.approve {id:53, roles:["admin"]}` | `{code:0, message:"已通过审核，角色：admin"}` | #53 `["out"]` → `["admin"]` | **否** | ❌ **危险：能授管理员** | 已降级+禁用（#53 → `["out"]`/disabled）|
| **P5 把自己改成 admin** | `user.updateRole {id:29, roles:["admin"]}` | `{code:403, message:"只有「管理员」才能授予「管理员」角色，请联系系统管理员操作"}` | 无变化 | **是** | ✅ 正确拦住 | 无需恢复（roles 仍 `["boss"]`）|
| **P6 把自己降级（自锁）** | `user.updateRole {id:29, roles:["out"]}` | `{code:400, message:"不能取消自己的管理权限（会把自己锁在系统外…）"}` | 无变化 | **是** | ✅ 正确拦住 | 无需恢复 |
| **P7 禁用自己** | `user.disable {id:29}` | `{code:400, message:"不能禁用自己的账号"}` | 无变化 | **是** | ✅ 正确拦住 | 无需恢复 |

### 判断（明确表态）

**老板能改、能禁用、能造管理员——这本身就是不被允许的。** 判据与理由：

1. **能降级管理员（P1）、能禁用管理员（P2）**：管理员账号是后台最高权限（能管用户、能作废已完成单据）。老板单点即可让管理员「消失」——哪怕能改回来，**在"消失"的那段时间里全系统是失管的**，而且老板若改完不恢复，别人根本无从察觉。手册与代码注释（`server/src/modules/user.js:14-21`）都表明系统**想**保护管理账号，但保护逻辑只覆盖「最后一个管理账号」和「自己」两种情形；由于系统里同时有 `admin#1`、`dev_boss#29`、`wangzong#10` 三个管理账号，admin 不是"最后一个"，于是保护被绕过。
2. **能创建 admin 账号（P3）、能 approve 授予 admin（P4）**：`user.updateRole` 里明明写了「只有管理员才能授予管理员角色」的边界（`user.js:159-161`），但**同一个边界没有写进 `user.create` 和 `user.approve`**。于是老板可以绕过 updateRole 的防线，用 create / approve 直接把任何一个账号（或新账号）变成管理员。这是**权限提权漏洞**，比 P1/P2 更彻底——不再需要"改别人"，而是直接"造出"一个管理员。
3. 对照之下，P5/P6/P7 的三条防线是**有效**的，说明"防自我提权/防自锁"的思路是对的，缺的是"**保护既有管理员 + 授予权限必须同级或更高**"这一层。

> 结论：**4 项危险操作全部成功（P1/P2/P3/P4）**，其中 P3/P4 属于「老板可凭空制造管理员」的提权级问题。

### 追责日志：能不能查到「老板把 admin 降级了」？

**能查到，且能定位到人。** `user.logs` 实际记录（原始报文见 `raw/`，此处摘关键字段）：

| 时间(UTC) | action | openid | user_name | role | target_id | detail |
|---|---|---|---|---|---|---|
| 12:00:03 | `user_update_role` | `dev_boss` | 开发·老板 | *(空)* | **1** | **修改用户「系统管理员」角色：admin、boss → out** |
| 12:00:03 | `user_disable` | `dev_boss` | 开发·老板 | *(空)* | **1** | **禁用用户「系统管理员」** |
| 12:00:03 | `user_approve` | `dev_boss` | 开发·老板 | boss | 1 | 审核通过用户「系统管理员」，角色：admin、boss（恢复动作）|
| 12:00:03 | `user_create` | `dev_boss` | 开发·老板 | *(空)* | 54 | 创建后台账号「V3R3_admin_...」，**角色：admin** |
| 12:00:03 | `user_approve` | `dev_boss` | 开发·老板 | boss | 53 | 审核通过用户「[V3-R3]边界测试账号」，**角色：admin** |

→ 「谁（dev_boss/开发·老板）」+「什么时候」+「改了什么（admin、boss → out）」三要素齐全，**追责链在本轮这几个动作上是通的**。
→ 但有 3 处缺口（见问题 P3/P6/P7）：**主数据变更完全无日志**、**失败/被拒的越权尝试无日志**、**多数 user_* 日志的 role 字段为空**。

### 抽 3 条日志去对应模块核验真实数据

| 日志 | 回查接口 | 回查结果 | 判定 |
|---|---|---|---|
| `user_create` target=54（12:00:03）| `user.detail{id:54}` | code=0，账号 `V3R3_admin_...` 存在（后被我按纪律改 `["out"]`/disabled）| ✅ 数据确实变了 |
| `purchase_task_create` target=19（11:59:54）| `purchase.detail{id:19}` | code=0，任务存在，status=`cancelled` | ✅ 数据确实变了 |
| `check_review` target=171（11:54:50）| `check.detail{id:171}` | code=0，`CHK-20261003-007`，status=`completed` | ✅ 数据确实变了 |

---

## 三、我报的问题

### [P0] 老板可以降级管理员账号（updateRole 对管理账号无保护）
- 我做了什么（原始请求）：
  ```json
  POST /api/user  {"action":"updateRole","data":{"id":1,"roles":["out"]}}
  Authorization: Bearer <dev_boss token>
  ```
- 系统回了什么（原始响应）：
  ```json
  {"code":0,"message":"角色已更新","data":null}
  ```
  随后 `user.detail{id:1}` → `roles:["out"]`（原为 `["admin","boss"]`）。
- 我认为哪里不对：管理员是后台最高权限账号，老板单点即可把它降成普通领料员。保护逻辑（`user.js:176 isLastActiveManager`）只覆盖"最后一个管理账号"，因系统存在 3 个管理账号而被绕过。**应禁止非管理员修改管理员账号的角色**。
- 有没有证据：**有**（`raw/003`、`raw/004`；已恢复，恢复后 `raw/008`）。

### [P0] 老板可以禁用管理员账号
- 原始请求：`POST /api/user {"action":"disable","data":{"id":1}}`（boss token）
- 原始响应：`{"code":0,"message":"已禁用该账号"}`；随后 `user.detail{id:1}` → `status:"disabled"`。
- 不对之处：同 P1，禁用管理员 = 让全系统审批/改账/管人停摆。`setStatus` 同样只保护"最后一个管理账号"（`user.js:225`）。
- 证据：**有**（`raw/009`、`raw/010`；已恢复 `raw/014`）。

### [P0] 老板可以创建「管理员」账号（user.create 缺授予边界）
- 原始请求：
  ```json
  POST /api/user {"action":"create","data":{"username":"V3R3_admin_...","roles":["admin"],"warehouse_ids":[1,2],...}}
  ```
- 原始响应：`{"code":0,"data":{"_id":54},"message":"账号创建成功"}`；`user.detail{id:54}` → `roles:["admin"]`, status=active。
- 不对之处：`updateRole` 明确拦截了「非管理员授予管理员」（`user.js:159-161`），但 `create`（`user.js:253-285`）**没有同样的校验**。老板可凭空制造一个管理员，提权更彻底。
- 证据：**有**（`raw/019`、`raw/020`；已降级+禁用）。

### [P0] 老板可以用 approve 给任意账号授予「管理员」
- 原始请求：`POST /api/user {"action":"approve","data":{"id":53,"roles":["admin"],"warehouse_ids":[1]}}`
- 原始响应：`{"code":0,"message":"已通过审核，角色：admin"}`；`user.detail{id:53}` → `roles:["admin"]`。
- 不对之处：`approve`（`user.js:113-141`）同样**只按 `VALID_ROLES` 过滤，不校验授予者能否授予 admin**，且不要求目标处于 `pending` 状态——对任意已有账号都能"审核通过并授予管理员"。
- 证据：**有**（`raw/017`、`raw/018`；已降级+禁用）。

> **根因归纳（P0 组）**：授予「管理员」这一动作存在**三条入口**（updateRole / create / approve），只有 updateRole 加了边界。**任何一条入口缺失，边界就等于不存在**。

### [P1] 主数据变更完全不留审计日志（追责链断裂）
- 我做了什么：老板成功执行了 `material.import`（新增 #2117）、`material.delete`、`supplier.upsert`（#73）、`supplier.delete`、`warehouse.upsert`（仓库#1）。
- 系统回了什么：全部 `code:0` 成功。
- 不对之处：`user.logs` 的 action 全集只有 `user_* / outbound_* / inbound_* / purchase_* / check_* / login`，**没有任何 `material_* / supplier_* / warehouse_*` action**。查代码确认：`material.js`、`supplier.js`、`warehouse.js` 三个模块 **`writeOpLog` 调用数为 0**。也就是说——**老板/管理员改物料、删物料、建/删供应商、改仓库，出了事查不到是谁干的**。这正是老板最痛的点。
- 证据：**有**（代码：`grep -c writeOpLog material.js supplier.js warehouse.js` = 0/0/0；日志 action 统计已落盘 `A4-logs-snapshot.json`）。

### [P2] 盘点审核：非明确 `true` 的表态不会"报错拦下"，而是把单子"退回"
- 我做了什么（原始请求）：`check.review {id:170, approve:"yes"}`（想验证手册 2.4「不传/传 yes 按没表态拦下」）
- 系统回了什么：`{"code":0,"message":"已退回，库存未做任何调整，请重新盘点后再提交","data":{"approved":false,"adjusted":0}}`，盘点单 **`pending_review` → `in_progress`**（被退回）。
- 我认为哪里不对：手册说"按没表态**拦下**"，期望是**报错且不改状态**；实际是**静默当成"退回"、改了状态且返回 code=0**。若前端漏传 `approve`（`undefined` → false），会把一张待审盘点单直接退回，操作者还以为没提交成功。
- 证据：**有**（`raw/...-cr-bad`）。已按原意恢复：`check.submit` + `review{approve:true}` → `completed`，diff=0，库存 50/47 未变。

### [P2] `warning.out_of_stock` 只统计"当前页"，与 KPI 的 `zero_count` 口径不一致
- 我做了什么：全量拉 `stats.warning`（pageSize=200）逐页统计。
- 系统回了什么：当前 `total=31`、`out_of_stock=11`，与 `overview.zero_count=11` 表面一致。
- 我认为哪里不对：代码 `stats.js:377` `outOfStock = rows.filter(...)`，`rows` 只是**当前这一页**（LIMIT 200）。当预警总数 > 200 时 `out_of_stock` 会**只数到第一页**，而 `overview.zero_count`（`stats.js:54`）是**全量**口径，两者必然对不上。当前数据量小（31<200）所以巧合相等，属**潜伏口径 bug**。
- 证据：**推测**（基于代码阅读 + 当前数值巧合吻合；未构造 >200 条预警数据）。

### [P2] 被拒绝的越权尝试不留痕
- 我做了什么：用 sk/out/purchase token 打了 15 次管理接口（全部 403），也试了 boss 的 P5/P6/P7（403/400）。
- 系统回了什么：全部拒绝。
- 不对之处：`operation_logs` 只记**成功**操作（`writeOpLog` 在角色校验通过、业务成功后才调用），**被拒的攻击尝试一条都没记**。近 200 条日志里 `result=fail / fail_reason` 计数为 **0**（表里有这两列但从未写入）。"出事能追到人"应包含"谁在尝试越权"。
- 证据：**有**（`A4-logs-snapshot.json`；失败尝试计数=0）。

### [P2] 多数 user_* 操作日志的 `role` 字段为空
- `updateRole / disable / enable / create / resetPassword` 写日志时**没有传 `role`**（只有 `approve`、`purchase_*` 传了）。日志里老板的危险操作 `role` 均为空字符串，只能靠 `user_name=开发·老板` 判身份。
- 证据：**有**（日志快照中 target=1/53/54 的 `user_update_role`/`user_disable`/`user_create` 行 `role:""`）。

---

## 四、全库对账表（签字依据）

> 取数时间：服务恢复后（12:08Z 附近）。4 个岗位同时在操作，故均为**同一时刻**抓取。

### 对账 A：`stats.overview` ↔ 明细接口

| overview 字段 | 值 | 明细来源 | 明细值 | 结论 |
|---|---|---|---|---|
| `warning_count` | 31 | `stats.warning.total` | 31 | ✅ 一致 |
| `zero_count` | 11 | `stats.warning` 全量中 `current_stock<=0` 计数 / 接口 `out_of_stock` | 11 / 11 | ✅ 一致（**但口径潜伏问题见 [P2] `warning.out_of_stock` 只统计当前页**）|
| `material_count` | 1919 | `stats.warehouseSummary` 两仓相加 | 1770+149=1919 | ✅ 一致 |
| `material_count` | 1919 | `stats.stockList.total` | 1919 | ✅ 一致 |
| `total_stock` | 103368 | 两仓 `total_stock` 相加 | 99412+3956=103368 | ✅ 一致 |
| `total_stock` | 103368 | `stats.stockList` 全量逐条 `current_stock` 累加 | 103368 | ✅ 一致 |
| `total_value` | 6432443.82 | 两仓 `total_value` 相加 | 6151542.2974+280901.5193=6432443.8167 | ✅ 一致（四舍五入到分）|

### 对账 B：`stats.warehouseSummary` 两仓逐列相加 = 合计

| 列 | 配件仓 | 成品仓 | 相加 | overview / 判定 |
|---|---|---|---|---|
| material_count | 1770 | 149 | 1919 | = 1919 ✅ |
| total_stock | 99412 | 3956 | 103368 | = 103368 ✅ |
| total_value | 6151542.2974 | 280901.5193 | 6432443.8167 | ≈ 6432443.82 ✅ |
| warning_count | 29 | 2 | 31 | = 31 ✅ |

### 对账 C：3 个【测试】物料，流水逐笔累加 = `material.detail` 当前库存

| 物料 | 流水条数 | 逐笔 `change_quantity` 累加 | 接口 `net_quantity` | 当前库存 | 结论 |
|---|---|---|---|---|---|
| #2100 火花塞 A型 | 13 | 91 | 91 | 91 | ✅ 相符 |
| #2105 轴承 F型 | 3 | 50 | 50 | 50 | ✅ 相符 |
| #2112 齿轮 G型 | 4 | 47 | 47 | 47 | ✅ 相符 |

### 对账 D：金额精度（第 1 轮 `140.1666` 复现确认）

- `stats.orderFlow` 共 63 条，其中 **23 条 `total_amount` 超过 2 位小数**。
- 第 1 轮报的 **`140.1666` 复现**：单号 `OUT-20261003-021`，`total_amount=140.1666`。
- 其它示例：`OUT-20261003-028` = `1512.636`、`OUT-20261003-035` = `44.8572`、`OUT-20261003-027` = `351.1662`。
- 判定：**复现**。库存成本金额按 `qty × avg_cost` 累加、`avg_cost` 保留 4 位小数，故单据金额带 3–4 位小数；老板按"分"对账会对不上。建议金额展示/存储统一四舍五入到 2 位（P1/P2，属老问题继续存在）。

> **对账总结论**：`overview` 的**每一个数**都能与明细/分仓对上；两个仓逐列相加等于合计；3 个测试物料账实一致。**数字本身可信**。唯一遗留是**金额 4 位小数**（老问题）和 **warning 口径潜伏问题**。

---

## 五、越权对照（用别人 token 打管理接口）

用 `dev_sk`（仓管）、`dev_purchase`（采购）、`dev_out`（领料）token 各打 5 个接口 = 15 次：

| 调用 | sk | out | purchase | 原始响应 |
|---|---|---|---|---|
| `user.list` | 403 | 403 | 403 | `{"code":403,"message":"无操作权限"}` |
| `user.logs` | 403 | 403 | 403 | 同上 |
| `user.updateRole` | 403 | 403 | 403 | 同上 |
| `user.disable` | 403 | 403 | 403 | 同上 |
| `user.create` | 403 | 403 | 403 | 同上 |

→ **15/15 全部被拒**。**结论：非管理角色无法触达管理接口，本轮独立复核通过**（第 2 轮后台 Agent 报的 P0 指的是"老板能授管理员"，不是"普通角色能进后台"，两者不矛盾）。

---

## 六、系统做对的地方（至少 3 条）

1. **角色路由有效**：sk/out/purchase 打 `user.*` 管理接口 15/15 全部 `403 无操作权限`（本系统对"哪些 action 需要哪些角色"的集中式校验是有效的）。
2. **老板不能自我提权**：`updateRole{id:29,roles:["admin"]}` 返回 `403 只有「管理员」才能授予「管理员」角色`——防自我提权这一层做对了（问题只在于 create/approve 没沿用）。
3. **老板不能自锁**：把自己降级返回 `400 不能取消自己的管理权限…`；禁用自己返回 `400 不能禁用自己的账号`；且保护"最后一个管理账号"的逻辑真实存在（只是没覆盖到"非最后一个管理员"）。
4. **危险操作可追责**：`user_*` 的角色/状态变更全部写入了 `operation_logs`，含 `openid + 姓名 + target_id + detail(旧值→新值)`，"老板把 admin 降级"能精确追到人。
5. **账实可复算**：`stats.stockFlow` 提供逐笔流水 + 服务端 `net_quantity`，我用它手工累加 3 个测试物料，与 `material.detail` 当前库存**分毫不差**——老板/仓管可独立复算。
6. **看板口径自洽**：`overview` 与 `warehouseSummary`/`stockList`/`warning` 各口径交叉一致，没有"两张表对不上"的情况。
7. **盘点审核不误动库存**：`CHK-20261003-006` 复核 diff=0，系统回"审核完成，账实相符，无需调整"，`adjusted=0`，未误改库存。
8. **导入拒绝凭空写库存**：`material.import` 明确拒绝 `current_stock` 等库存字段（提示"库存请用入库单建立，这样才有流水和责任人"）——从设计上堵死了"改账查不到人"的路径。

---

## 七、我这个岗位愿不愿意继续用 / 敢不敢签字

**对账数字我敢认，但我现在不敢签字。**

- **不敢签的原因**：本轮核心就是"我这个老板到底能干什么"。实测结论是——**老板能把管理员降级、禁用、凭空再造一个管理员**（P1/P2/P3/P4 四项 P0）。这意味着"管理员"这道权限闸门对老板形同虚设：我一个人就能把后台最高权限换个遍，**而且改完不恢复，别人查日志才知道**。更糟的是，**物料/供应商/仓库这些主数据的改动根本没有审计日志**（P1），"出了事能不能查到是谁干的"在这类操作上是**否**的。
- **签字条件（建议整改后我再签）**：
  1. 只有 `admin` 能修改/禁用**任何管理账号**（boss/admin），boss 不能动 admin（P1/P2）；
  2. `user.create` 与 `user.approve` 必须加与 `updateRole` 一致的"授予 admin 需 admin"边界（P3/P4）；
  3. `material.* / supplier.* / warehouse.*` 主数据变更必须写 `operation_logs`（P1-日志）；
  4. 被拒的越权尝试也要留痕（P2）。
- **可以马上放心的部分**：库存数字、看板、流水、对账——**账实相符、口径自洽**，日常经营看数没问题；日常让仓管/采购/领料干活也没问题（越权全部被拒）。卡住的就是**权限边界**和**主数据审计**这两件事。

---

## 附带说明

- **服务中断**：约 12:02Z（本地 20:02）测试进行到 B 组时，`http://127.0.0.1:3000` 进程自行退出（`srv-3000-v4.log` 末尾无异常堆栈，疑被其他岗位的进程管理动作回收）。我**按纪律没有重启**，轮询约 5 分钟后由**其他岗位**恢复（12:07:44Z UP），随后继续完成 B 组。中断期间的信息仅此一条，不影响 A/C 结论。
- **数据清理**：`supplier#73` 已软删；`material#2117` 已软删；`outbound#626`/`purchase#22` 已作废；`user#53/#54` 无法物理删除（无删除接口，与第 2 轮 `#52` 同类），已**降级为 `["out"]` 并禁用**；`warehouse#1` 原值回写未变；`admin#1` 已恢复 `["admin","boss"]/active`；`dev_boss#29` 保持 `["boss"]/active`。
- **原始证据**：`.tmp-local-audit/bossr3/raw/*.json`（共 100+ 条，含每条请求的 URL/action/data/Authorization 与原始响应）；脚本在 `.tmp-local-audit/bossr3/*.js`。
