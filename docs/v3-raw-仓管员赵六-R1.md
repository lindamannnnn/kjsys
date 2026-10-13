# 仓管员 Agent 测试汇报（第 1 轮）

> 测试人：赵六（模拟身份 `dev_sk`，仓管员，管配件仓[1] + 成品仓[2]）
> 环境：本机 `http://127.0.0.1:3000`（未重启、未改代码）
> 标记：本轮所有自建单据 `remark` 均含 `[V3-R1]`；只操作 `【测试】` 前缀物料
> 请求方式：`node` 临时脚本（`.tmp-local-audit/`），未用 curl

---

## 一、我干了什么（按时间顺序）

1. **上班打开工作台**（按工作台页面加载顺序）：
   - `stats.overview` → `code:0`，`pending_outbound=3 / picking_outbound=1 / receiving_outbound=1 / pending_inbound=2 / pending_checks=3`
   - `outbound.pendingCount` → `3`；`outbound.pickingCount` → `1`；`inbound.pendingCount` → `2`
   - `outbound.list`（total 21，待处理：`OUT-016`=606 pending、`OUT-017`=607 picking、`OUT-018`=608 receiving）
   - `inbound.list`（total 16，待处理：`IN-20261001-006`、`IN-20261001-004` pending）
   - 结果：工作台各计数与列表一致，一眼能看到今天要处理的活。

2. **处理待确认出库单 `OUT-20261003-016`（id 606）**：`outbound.detail`（pending，2 项：火花塞A×5、点火线圈B×3）→ `outbound.confirm` → `code:0`，`message:"已确认，请按清单拣货"`，状态变 `picking`。
   - **验证库存未动**：确认前后 `material.detail` — 火花塞A(2100) `85 → 85`、点火线圈B(2101) `54 → 54`。符合「库里要到确认收货才扣」。

3. **处理待拣货单 `OUT-20261003-017`（id 607）**：`outbound.pickDone` → `code:0`，`message:"拣货完成，已通知领料员来收货"`，状态变 `receiving`。
   - **看领料员有没有收到消息**：领料员 App 消息列表新增 `message id=156`，`type=outbound_picked`，标题「你的领料单已拣货完成，请来收货」，内容含单号 `OUT-20261003-017` 和项数。→ **通知真实投递到了人。**

4. **收料采购任务 `CG-20261003-013`（id 13）**：
   - 第一次 `purchase.receive` 被拒：`code:400`「只有「待收料」的任务可以收货入库（当前状态：采购中）」。**回查确认是采购员正在并发录入**，不是我的问题（详见「三、系统做对的地方」第 6 条）。
   - 回查 `purchase.detail` 已是 `purchased`：单价 **8.5**、渠道 **京东**、外部单号 `JD-2026-001`。
   - 重新 `purchase.receive` → `code:0`，`message:"收料入库成功，已生成入库单 IN-20261003-006"`，任务变 `received`。
   - **生成的入库单号：`IN-20261003-006`**（成品仓、供应商「京东」、金额 85 = 8.5×10）；齿轮G(2112) 库存 `24 → 34`（+10）。

5. **做一张直接入库单（自己开单）**：
   - `material.list {warehouse_id:1, keyword:"【测试】"}` → 命中 5 项，选火花塞A(2100)
   - `inbound.submit`（`supplier` 必填、每项带 `unit_price:13.5`、`remark:"[V3-R1] 仓管直接入库-火花塞A"`）→ `code:0`，生成 **`IN-20261003-007`**，total_price 135
   - **验证「提交即加库存」**：submit 前 `85` → **submit 后 `95`** → `inbound.detail`（pending）→ `inbound.confirm` `code:0` → **confirm 后仍 `95`**（不重复加），单据变 `confirmed`。

6. **盘点成品仓 `CHK-20261003-004`（id 168）**：`check.detail` → `check.submit` 录入实盘（轴承F=50 与库存一致；齿轮G=**37**，比当前库存 34 多 3，故意制造盘盈）→ `code:0`，`message:"盘点结果已提交，共 2 项（差异 1 项），等待老板审核"`，状态变 **`pending_review`「待审核」**；提交后库存仍未调整（50 / 34），等老板审。

7. **发布一张新的采购任务**：`purchase.assignees`（可指派 `dev_worker_01`、`dev_purchase`）→ `material.list` 选点火线圈B(2101) → `purchase.create`（`assignee_openid:"dev_purchase"`，`remark:"[V3-R1] 仓管发布采购-点火线圈B"`）→ `code:0`，`message:"采购任务已发布，已通知采购员"`，生成 **`CG-20261003-014`**（open/待领取），采购员收到 `message id=164`。

8. **看待办计数变化**：`purchase.myTodoCount` → `{can_take:0, in_progress:2, waiting_receive:2, total:2}`；`outbound.pendingCount` → `3`；`outbound.pickingCount` → `1`；`inbound.pendingCount` → `2`；`stats.overview.pending_checks` → `2`（我那张盘点到「待审核」了）。回查列表后确认数字都对得上（见下）。

---

## 二、我报的问题

### [P1] 盘点：页面「账面数 / 差异」用的是建单那一刻的快照，服务端却按提交时的实时库存算差异 → 盘点期间货一动就凭空多出盘盈盘亏

- **我做了什么**：`check.detail {id:168}` 看盘点单（原始响应见下）。
- **系统回了什么**（原始响应关键字段，完整见 `.tmp-local-audit/raw-sk-r1/01_*-check-detail.json`）：
```jsonc
{"code":0,"data":{"check_no":"CHK-20261003-004","status":"pending","status_text":"待确认",
  "items":[
    {"material_id":2105,"book_stock":50,"actual_stock":null,"current_stock":50},
    {"material_id":2112,"book_stock":24,"actual_stock":null,"current_stock":34}   // 账面24，实时34
  ]}}
```
- **我认为哪里不对**：同一行同时给了 `book_stock`（建单快照=24）和 `current_stock`（实时=34），两个数不一样（因为这期间我 `purchase.receive` 入了 10 个齿轮G）。
  - 服务端算差异用的是**实时库存**：`server/src/modules/check.js:375-382`（注释「刷新账面数 = 提交这一刻的真实库存」）。
  - 但小程序盘点页判断差异、以及「按账面数填入」按钮用的是**快照 `book_stock`**：`miniprogram/src/pages/check/submit.vue:141`（`item.difference = num - Number(item.book_stock)`）和 `:150`（`item.actual_stock = String(item.book_stock …)`）。
  - 后果：仓管在页面上看到「账面 24、差异 0」，一点提交，系统却按实时 34 记成 **盘亏 10**。页面上显示的和实际记进账的对不上——**这正是我最怕的「账实不符」，而且锅会扣在我头上**。5 个岗位同时在线时，盘点期间有别的出入库是常态，这个坑几乎必然踩。
- **应该是什么样**：要么盘点单创建后冻结库存（`freeze_stock:true` 时真正拦截该料的出入库），要么盘点页展示/计算差异时统一用**实时库存**，并明确标注「账面数为当前实时值」。总之页面看到的差异必须等于系统记录的差异。
- **有没有证据**：**有证据**（原始响应 + 源码行号）。

### [P1] 测试手册 `check.submit` 的字段名写错，照手册提交必被拒（文档问题，非应用缺陷）

- **我做了什么**：严格按《V3-TEST-GUIDE》第三节「关键入参速查」提交：
```json
{ "action":"submit", "data":{ "id":168, "remark":"[V3-R1] 成品仓盘点录入",
  "items":[ {"material_id":2105,"actual_quantity":50,"remark":"账实一致"},
            {"material_id":2112,"actual_quantity":37,"remark":"盘盈3（测试）"} ] } }
```
- **系统回了什么**（原始响应，完整见 `raw-sk-r1/01_*-check-submit.json`）：
```json
{ "code":400, "data":null, "message":"「【测试】轴承 F型」的实盘数量必须是数字（当前填入：undefined）" }
```
- **我认为哪里不对**：手册写的是 `actual_quantity`，但服务端读的字段其实是 **`actual_stock`**（`server/src/modules/check.js:357`）。前端（小程序 `check/submit.vue:201`、后台 `admin/.../check/list.vue:341`）发的也是 `actual_stock`，**前后端本身是一致的**，所以这是**手册这行写错了**，不是应用 bug。
- **应该是什么样**：手册第七/三节把 `actual_quantity` 改成 `actual_stock`。否则新人/第三方接入方照手册写，会在「实盘数量必须是数字」这种看不懂的报错上卡住（明明填了 50 却说 undefined）。
- **有没有证据**：**有证据**（原始请求 + 原始响应 + 前后端源码）。
- 备注：改用 `actual_stock` 后提交成功——`{"recorded":2,"diff":1}`，状态正确流转到 `pending_review`，说明**应用功能本身没问题**。

### [P2] 盘点单的草稿态文案是「待确认」，容易让人以为在等别人确认

- **我做了什么**：`check.detail {id:168}`（此时单据刚由系统建好，还没录入）。
- **系统回了什么**：`"status":"pending"`，`"status_text":"待确认"`。
- **我认为哪里不对**：手册第 2.4 节把这一阶段定义为 `draft`（草稿，等仓管自己录入）。但接口吐出的是「待确认」——在出库语境里「待确认」是「等**别人**来操作」，搁在盘点单上会让我以为要等谁来点确认，可能干等着不敢录入。同名不同义，容易误事。
- **应该是什么样**：草稿态文案改成「待盘点 / 待录入」，和「待审核」区分开。
- **有没有证据**：**有证据**（原始响应）；文案是否误导属主观判断。

### [P2·推测] 历史待确认出库单却已标记 `stock_deducted=1`，状态自相矛盾

- **我做了什么**：`outbound.list {page:1,page_size:20}`。
- **系统回了什么**（原始响应节选）：
```jsonc
{"order_no":"OUT-20261001-008","status":"pending","status_text":"待确认","stock_deducted":1, ...}
{"order_no":"OUT-20261001-004","status":"pending","status_text":"待确认","stock_deducted":1, ...}
```
- **我认为哪里不对**：按手册 2.1，`pending` 阶段「提交不动库存」，`stock_deducted` 只可能在走完 `receive` 后为 1。这两张 `pending` 单却是 `stock_deducted=1`，等于「没收货但库存已扣」，是账实不符的味道。
- **有没有证据**：**推测**——数据状态有原始响应佐证，但这两张是 10-01 的历史 E2E 遗留单（`updated_at` 是 10-03 10:52），这轮我没有复现路径，无法确认成因。建议开发查一下这两张单的流水。
- 影响：它们一直占着我的「待确认」红点，得手动处理掉。

---

## 三、系统做对的地方

1. **出库「确认收货才扣库存」语义正确**：`outbound.confirm` 后火花塞A/点火线圈B 库存纹丝不动（`85→85`、`54→54`），只在最后 `receive` 才扣。避免了「点了确认就先扣、货没领走库存就少了」的错账。
2. **直接入库「提交即加库存」语义正确且不重复加**：`inbound.submit` 后 `85→95`，`inbound.confirm` 后仍 `95`。两条相反语义（出库 vs 入库）分别实现，没搞混。
3. **收料入库自动生成入库单、金额算得对**：`purchase.receive` 返回里直接带 `inbound_order_no:"IN-20261003-006"`，入库单金额 `8.5×10=85` 正确，`message` 也提示了单号，方便我对账。
4. **按 openid 的消息通知真实可达人**：`pickDone` 让领料员收到 `id=156`「已拣货完成，请来收货」；`purchase.create` 让采购员收到 `id=164`「新的采购任务」。通知内容带单号，不是空消息。
5. **状态机的拦截清晰、文案有用**：对「采购中」的任务 `receive` 被明确拒绝并报出当前状态（`只有「待收料」的任务可以收货入库（当前状态：采购中）`）；盘点填了非数字也精确报出是哪一项、填了什么。出错知道怎么改。
6. **并发下数据最终一致**：我一度看到 `CG-013` 从 `purchased` 变 `taken`、`receive` 被拒——回查 `purchase.list` 后确认是采购员正在并发录入，稍后即恢复 `purchased`。系统把「别人刚动过」如实反映出来了，没有错乱。
7. **待办计数与列表严格对账**：`purchase.myTodoCount` 的 `waiting_receive=2` 正好等于列表里 2 张 `purchased`；`outbound.pendingCount=3` 对应 3 张 `pending`（其中 1 张是领料员并发新提的 `OUT-019`）。红点数可信，能指导我干活。
8. **数据权限收敛正确**：`dev_sk` 管 [1,2]，配件仓和成品仓的单据都能看能处理，没有越界。

---

## 四、我这个岗位愿不愿意继续用 / 敢不敢签字

- **愿不愿意继续用：愿意。** 收发货、收料、自己开入库单、发采购这几件事都顺手，待办计数和消息通知能直接告诉我「今天该干嘛、货到没到」，比我现在靠脑子记强。
- **敢不敢签字：盘点的结果，我暂时不敢签。**
  卡在第二节第一条：盘点页面上显示给我的「账面数 / 差异」是建单时的快照，而系统入库记的是提交那刻的实时库存，两者一旦对上不就会凭空冒出一笔盘盈或盘亏——**这恰恰是我最怕背的「账实不符」的锅**。
  只要这一个改到位（盘点期间冻结库存，或页面统一显示实时库存、所见即所记），加上手册的字段名改对，我就敢签字。
