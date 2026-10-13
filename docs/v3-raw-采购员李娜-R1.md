# 采购员（李娜）Agent 测试汇报（第 1 轮）

> 身份：`dev_purchase`（模拟微信身份），角色 `purchase`，可管仓库 [1 配件仓, 2 成品仓]。
> 工具：`node` 临时脚本（`.tmp-local-audit/call.js`，走 `POST /api/<模块>`，`Authorization: Bearer <token>`）。
> 说明：我没有动手改任何代码，也没有重启服务；只读 + 录入自己的采购任务，`remark` 均带 `[V3-R1]`。
> 备注：第 1 轮我与另外 4 个岗位同时在线上跑，看到的状态与上下文对不上时我都先回查确认过。

## 一、我干了什么

按时间顺序（时间取自响应里的 `created_at/updated_at`，UTC）：

1. **上班看任务**：`purchase.myTodoCount` → 返回 `{can_take:1, in_progress:2, total:3}`；`purchase.list` → 看到 3 条任务：CG-20261003-011（open/待领取）、CG-20261003-012（taken/采购中）、CG-20261003-013（taken/采购中）。
2. **回查不符**：上下文 `todos.purchase` 标 CG-013 为 `purchased`（待收料），但实时列表/详情是 `taken`（采购中，`purchased_at=null`）。先 `purchase.detail` 逐个确认，见问题 1。
3. **领取待领取任务**：`purchase.detail {id:11}`（看它要买「【测试】机油滤芯 D型」×20）→ `purchase.take {id:11}` → 回执「领取成功，请尽快采购并录入」→ 再 `purchase.detail {id:11}` 确认状态变 **taken（采购中）**、`taker_openid=dev_purchase`（11:46:27）。
4. **录入采购信息（主业）**：
   - 对 taken 任务 **CG-012**：`purchase.entry {id:12, purchase_channel:"淘宝", external_no:"TB-2026-001", remark:"[V3-R1] 空气滤芯E已购", items:[{material_id:2104, quantity:15, unit_price:12.5}]}` → 回执「已提交，等待仓管收货入库」，`status=purchased`；`detail` 确认 **待收料**，`total_amount=187.5`（=15×12.5），`remark` 落库（11:46:49）。
   - 顺手把同样在手的 **CG-011** 也录入（清理手上任务）：`purchase.entry {id:11, purchase_channel:"线下", external_no:"XX-2026-001", remark:"[V3-R1] 机油滤芯D已购", items:[{material_id:2103, quantity:20, unit_price:6}]}` → `status=purchased`，`total_amount=120`（=20×6）（11:47:05）。
   - **CG-013 补录**：它标着「待收料」实际却是「采购中」，为不卡住仓管，我按正常作业补录 `purchase.entry {id:13, purchase_channel:"京东", external_no:"JD-2026-001", remark:"[V3-R1] 齿轮G已购", items:[{material_id:2112, quantity:10, unit_price:8.5}]}` → 变 `purchased`（11:47:16）。
5. **看仓管收料**：`purchase.list` 回查 → **CG-013 已变 `received`（已入库）**，`inbound_order_id=584`、`inbound_order_no=IN-20261003-006`、`received_at=11:47:27`。入库单号已记下。（CG-011、CG-012 仍为 `purchased/待收料`，等仓管收。）
6. **对账相关（月底用的）**：`stats.orderFlow {page:1}`、`stats.warning {page:1,page_size:20}`、`stats.stockFlow {material_id:2103}`、`stats.stockList {warehouse_id:1,page:1}` —— 四个全部 `code:0`，数据能看懂（详见问题 2）。
7. **消息中心**：`message.list` → 14 条未读（含一条「你的采购任务已完成入库：CG-20261003-013 已由开发·仓管收料入库（入库单 IN-20261003-006）」）；`message.markRead {id:161}` 标记该条已读 → `message.unreadCount` 由 **14 → 13**；`message.list {only_unread:true}` 确认参数生效（返回 13 条，已读那条不再出现）。
8. **越界动作（如实记录）**：`outbound.confirm {id:609}`（确认出库单，仓管的活）→ 系统回 **`code:403`、`message:"无操作权限"`**。这是**正确行为**，见「系统做对的地方」。
9. **收尾回查**：`purchase.myTodoCount` → `{can_take:0, in_progress:2, total:2}`，与 list 自洽（剩 CG-011、CG-012 两条待收料）。

## 二、我报的问题

### [P2] 采购任务的标识「待收料」与真实状态「采购中」不一致，上下文也标成待收料
- **我做了什么**：按上下文 `todos.purchase.purchased = {id:13, no:"CG-20261003-013", status:"purchased"}` 去处理，第一步先 `purchase.detail {id:13}` 回查。
- **系统回了什么**（原始响应关键字段，11:45 左右）：
  ```json
  { "code":0, "data": { "task_no":"CG-20261003-013", "status":"taken", "status_text":"采购中",
    "remark":"[V3-SETUP] 采购F-待收料", "purchased_at":null, "received_at":null,
    "reject_reason":null, "cancelled_at":null, "total_amount":0 } }
  ```
  即：`remark` 写着「待收料」、上下文也标 `purchased`，但接口真实状态是 `taken`（采购中），`purchased_at` 为空、`reject_reason` 也为空。
- **我认为哪里不对**：任务名/上下文与实际状态对不上，采购员会误判「这条已经交给仓管了、不用我管」，从而**漏掉一条该录入的任务**（我这次是靠 `detail` 回查才发现的）。如果 `purchased` 被标错，用户按列表看不到「待我录入」的提醒。**建议**：要么保证状态与 `remark`/上线上下文一致，要么列表/详情在 `status=taken` 时明确提示「待你录入」。
- **有没有证据**：**有原始响应**（上）。根因**推测**：这是种子/环境数据在 `take` 后未执行 `entry` 就落库（`remark` 是按计划写的目标态），不一定是接口逻辑错误——`purchased_at`、`reject_reason` 同时为空，排除了「入库后回退 / 被仓管退回」这两种可能。

### [P2] 对账流水里出现 4 位小数的金额，月底对账金额不规整
- **我做了什么**：`stats.orderFlow {page:1}`（采购员月底对账入口）。
- **系统回了什么**（原始响应节选）：
  ```json
  { "kind":"outbound", "order_no":"OUT-20261003-018", "status":"completed",
    "total_qty":7, "total_amount":140.1666 }
  ```
  同批其它单是 `69.8`、`167.5`、`215`，都是规整的；这张却是 `140.1666`（4 位小数）。
- **我认为哪里不对**：金额字段是给人对账用的，`140.1666` 看着不像钱（应是 2 位小数，如 `140.17`）。采购员月底拿这个数对账、抄数会别扭，也容易怀疑算错。**建议**：金额统一保留 2 位小数（四舍五入）。
- **有没有证据**：**有原始响应**。根因**推测**：出库成本按物料均价（`avg_cost`）加权计算时未做金额取整，属于展示/计算精度问题，不影响库存数量。

> 说明：只报了这 2 条我能拿原始请求/响应说清的。权限相关的拒绝、消息隔离、幂等拦截等，按手册都属于「正确行为」，我不当问题报（见下一节）。

## 三、系统做对的地方

1. **越权被正确拦下**：采购员调 `outbound.confirm`（仓管的活）→ `POST /api/outbound {action:"confirm",data:{id:609}}` 返回 `code:403 / message:"无操作权限"`，没有让我改到出库单。角色边界清晰。
2. **采购录入的状态机和金额计算正确**：`take` 后 `open→taken`，`entry` 后 `taken→purchased`；`total_amount` 与明细吻合（15×12.5=187.5、20×6=120、10×8.5=85）。三个中文渠道（淘宝/线下/京东）都被接受。
3. **仓管收料后自动回填入库单并通知采购员**：CG-013 收料后 `purchase.detail` 回填 `inbound_order_no=IN-20261003-006`、`received_at=11:47:27`，且消息中心收到 `purchase_received` 通知，内容与单号一致。
4. **消息按 openid 隔离且读状态正确**：`markRead {id:161}` 后 `unreadCount` 14→13，`message.list {only_unread:true}` 立即生效（手册要求的 `only_unread` 参数名可用）。
5. **统计/对账接口对采购员只读放开且按仓库收敛**：`stats.orderFlow / warning / stockFlow / stockList` 四个全部 `code:0`；`stockFlow {material_id:2103}` 给出 `before_stock/after_stock/net_quantity=39` 的完整流水，`stockList {warehouse_id:1}` 给出 `stock_value`，采购员能看懂、够对账用。
6. **我的待办计数与列表自洽**：初始 `{can_take:1,in_progress:2,total:3}` 对应 011/012/013；干完后 `{can_take:0,in_progress:2,total:2}` 对应仍待收料的 011/012。没有出现「列表有、计数没有」的遗漏。

## 四、我这个岗位愿不愿意继续用 / 敢不敢签字

**愿意继续用，但暂时不敢在月底对账上直接签字。**

- 愿意用的理由：正常流程（看任务 → 领取 → 录入 → 等仓管收料 → 收通知）全程跑通，权限边界清楚（越权被 403 拦），消息能真实投到我的账号，任务计数和列表对得上，没发现会算错库存或卡死流程的问题。
- 不敢直接签字卡在哪：
  1. 任务标识与真实状态不一致（问题 1）——我最怕的就是「任务有没有遗漏」，`remark` 写「待收料」实为「采购中」，光看列表会被骗，必须逐条 `detail` 才能确认，这对「不漏任务」是隐患。
  2. 对账金额出现 4 位小数（问题 2）——月底对账要按金额核，金额不规整会让我不敢直接抄数。
- 结论：**愿意继续用**；上面两条（尤其问题 1 的状态/标识一致性）修好或说明清楚后，我才敢在月底对账结果上签字。
