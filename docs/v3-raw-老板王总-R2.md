# 老板（王总）Agent 测试汇报（第 2 轮 · 恶意/越权专测）

> 身份：`dev_boss`（王总（模拟），roles=`["boss"]`，可管仓库 [1,2]）
> 环境：`http://127.0.0.1:3000`（**未重启、未改代码**）
> 脚本：`G:/sl/shenglong-erp/.tmp-local-audit/r2-boss-lib.js` 及 `r2-step*.js`（全部用 `node` 发请求，未用 curl 发中文 JSON）
> 原始报文目录：`G:/sl/shenglong-erp/.tmp-local-audit/raw-boss-r2/`
> 我只碰 `【测试】` 前缀物料；自建单据 remark 带 `[V3-R2]`。所有被改动的数据均已恢复（见文末「数据恢复清单」）。

---

## 一、我干了什么（按时间顺序）

| # | 动作 | 目标 | 结果 |
|---|---|---|---|
| 0 | `auth.login{dev_openid:dev_boss}` 拿新 token | — | 成功（uid=29）。随后 `check.list` 轮询 6 次（约 30s），**始终没有「待审核」**（仓管未提交；`CHK-20261003-006`/id170 仍停在初始态「待确认」）。按任务「若一直没有可自建」的约定，本轮审批测试**改为我自建一张 `[V3-R2]` 盘点单**构造待审态。 |
| 0′ | （事后回查）仓管在我测试结束后才提交 | `CHK-20261003-006`（id170，`dev_sk`） | 回查时它已变成 `pending_review`。**那是仓管/其他岗位流程的单，我不消费它**，故未在它上面做审批门禁（A 组结论在自建单 id171 上取得，与具体单无关，走同一段代码）。 |
| A1 | `check.create`+`check.submit` | 新单 `CHK-20261003-007`（id **171**，物料 2100 火花塞A型，仓库1） | 创建+提交成功，状态 `pending_review`/待审核 |
| A2 | `check.review` **不传 approve** | 171 | **被拦**：`code=400「请明确选择「通过」或「退回」」`，状态仍 `pending_review`，**没有默认通过** |
| A3 | `check.review{approve:"yes"}` | 171 | **未被拦**：`code=0`「已退回」，返回 `approved:false`，状态被改成 `in_progress`（老板「想通过」被静默做成「退回」） |
| A4 | 重新 `submit`→`review{approve:2}` | 171 | **未被拦**：同 A3，`code=0`「已退回」，状态 → `in_progress` |
| A5 | 重新 `submit`→`review{approve:false}` | 171 | `code=0`「已退回」（**与预期一致**），状态 → `in_progress` |
| A6 | 重新 `submit`→`review{approve:true}` | 171 | `code=0` 通过（`approved:true`），状态 → `completed`，账实相符未调库存 |
| A7 | 对已完成单再 `review` | 171 | **被拦**：`code=400「当前状态「已完成」不支持审核」` |
| B7 | `user.updateRole{id:29,roles:["admin"]}`（给自己提权） | 自己 | **被拦**：`code=403「只有「管理员」才能授予「管理员」角色」` |
| B8 | `user.updateRole{id:1,roles:["out"]}`（降级 admin） | admin(id1) | **未被拦**：`code=0「角色已更新」`，admin 角色真被改成 `["out"]`（随后恢复） |
| B9 | `user.disable{id:1}`（禁用 admin） | admin(id1) | **未被拦**：`code=0「已禁用该账号」`，admin 状态真变成 `disabled`（随后恢复） |
| B10 | `user.disable{id:29}`（禁用自己） | 自己 | **被拦**：`code=400「不能禁用自己的账号」` |
| B11 | `user.updateRole{id:1,roles:["superadmin"]}`（非法角色） | admin(id1) | **被拦**：`code=400`，但文案是「角色不能为空」（误导），admin 角色未变 |
| B12 | `user.create{roles:["admin"]}`（建管理员账号） | 新账号 id52 | **未被拦**：`code=0「账号创建成功」`，新账号 `roles:["admin"]`、active（随后降级+禁用） |
| C13 | `check.detail{id:999999}` / `outbound.detail{id:999999}` | 不存在 id | **被拦**：分别 `code=404「盘点任务不存在」`/`code=404「单据不存在」` |
| C14 | `stats.overview` **不带 token** | — | **被拦**：`code=401「请先登录」` |
| C15 | `stats.overview` **伪造 token** | — | **被拦**：`code=401「登录已过期，请重新登录」` |
| D16 | `stats.warning{pageSize:500}` | — | **按上限封顶**：返回 `pageSize:200`、实际 31 条（当前无更多数据，封顶生效） |
| D17 | `stats.trend{days:7}` | — | 返回 **8 个数据点**（`2026-09-26 ~ 2026-10-03`），`days` 回显 7（N+1，复现） |
| D18 | `stats.stockFlow{material_id:999999}` | 不存在物料 | `code=0` 空列表 `{list:[],total:0,net_quantity:0}`（不报错，静默空） |

---

## 二、我报的问题

### [P0] 老板（非管理员）能把系统管理员「降级」成普通员工

- 我做了什么（原始请求）：
  ```json
  POST /api/user  {"action":"updateRole","data":{"id":1,"roles":["out"]}}
  ```
  （调用者 token = `dev_boss`，roles=`["boss"]`，**不含 admin**；id=1 是 `username:"admin"`、roles=`["admin","boss"]` 的系统管理员）
- 系统回了什么（原始响应）：
  ```json
  {"code":0,"data":null,"message":"角色已更新"}
  ```
  随后回查 `user.detail{id:1}` 证实角色真被改掉：
  ```json
  {"code":0,"data":{"username":"admin","real_name":"系统管理员","roles":["out"],"status":"active","_id":1},...}
  ```
  对照：同样是不含 admin 的老板去给自己加 admin（B7），却被正确拦下 `code=403`。说明系统**知道**「只有管理员能授予/管理 admin」，却在「改别人的 admin 角色」这条路径上没生效。
- 我认为哪里不对 / 应该是什么样：
  服务端 `user.js:159` 的授权边界只判断了「**授予** admin」（`roles.includes('admin')`），没判断「**剥夺** admin」。当目标是管理账号、且系统里还有别的管理账号（本例还有老板账号 id10/id29）时，`user.js:176` 的「最后管理账号」保护不触发，`user.js:167` 的「不能取消自己权限」也不触发（被改的不是自己）→ 于是老板可以**把管理员踢下台**。
  正确行为：管理账号（admin/boss）的角色变更，只允许管理员来操作；或至少禁止非 admin 修改 admin 账号。
- 有没有证据：**有证据**（原始请求+原始响应+回查 detail + 代码定位 `user.js:155-182`）。

### [P0] 老板（非管理员）能「禁用」系统管理员

- 我做了什么（原始请求）：
  ```json
  POST /api/user  {"action":"disable","data":{"id":1}}
  ```
- 系统回了什么（原始响应）：
  ```json
  {"code":0,"data":null,"message":"已禁用该账号"}
  ```
  回查 `user.detail{id:1}`：
  ```json
  {"code":0,"data":{"username":"admin","roles":["admin","boss"],"status":"disabled","_id":1},...}
  ```
- 我认为哪里不对 / 应该是什么样：
  `user.js:225` 的 `isLastActiveManager` 判定「是不是系统里最后一个在用的管理账号」，它把 boss 也算作管理账号。系统里还有老板账号（id10/id29 都是 boss 且 active），所以 admin 不算「唯一」，拦不住 → 禁用成功。
  后果：老板一按就能把管理员账号停掉（管理员管理的后台、作废已完成单据等能力随之失效）。虽然不是「把自己锁死」，但**一个非管理员能停用管理员**，是权限失效。
  正确行为：禁用管理账号应由管理员操作，或至少非 admin 不能禁用 admin。
- 有没有证据：**有证据**（原始请求+响应+回查 detail + 代码定位 `user.js:213-231`）。

### [P0] 老板能直接「创建」一个管理员账号 —— `user.create` 完全没有授权边界

- 我做了什么（原始请求）：
  ```json
  POST /api/user  {"action":"create",
    "data":{"username":"V3R2_audit_1791028547046","password":"audit123456",
            "real_name":"[V3-R2]越权测试账号","roles":["admin"],"warehouse_ids":[1]}}
  ```
- 系统回了什么（原始响应）：
  ```json
  {"code":0,"data":{"_id":52},"message":"账号创建成功"}
  ```
  回查 `user.detail{id:52}`：
  ```json
  {"code":0,"data":{"username":"V3R2_audit_1791028547046","real_name":"[V3-R2]越权测试账号",
    "roles":["admin"],"status":"active","_id":52},...}
  ```
- 我认为哪里不对 / 应该是什么样：
  `user.updateRole` 里明明白白写着「只有「管理员」才能授予「管理员」角色」（`user.js:159`），但 `user.create`（`user.js:253-285`）**一行这样的校验都没有**，`user.approve`（`user.js:113-141`）同样没有。于是只要老板有 `user.create` 权限，就能凭空造一个 admin 账号，绕过刚刚防住的提权边界。
  **同一漏洞的第二个入口（都是我实测撞到的）**：我在恢复 B8 时，用老板 token 调了
  ```json
  POST /api/user {"action":"approve","data":{"id":1,"roles":["admin","boss"],"warehouse_ids":[]}}
  → {"code":0,"data":null,"message":"已通过审核，角色：admin、boss"}
  ```
  老板本来就能通过 `approve` 把 admin 角色授予任意账号，说明「admin 只能管理员授予」这条规则**只在 `updateRole` 生效**，`create`/`approve` 两个入口都漏了。
  正确行为：与 `updateRole` 对齐 —— 非 admin 调用 `create`/`approve` 时，不允许出现 `admin` 角色。
- 有没有证据：**有证据**（create 原始请求+响应+回查 detail；approve 原始请求+响应）。

### [P1] 盘点审核传 `approve:"yes"` / `2`：不报错，把老板的「通过」静默做成「退回」

> 这条是第 1 轮已报过的问题，本轮**独立复现**，结论一致。

- 我做了什么（原始请求，同一张待审单 id=171，依次尝试）：
  ```json
  POST /api/check {"action":"review","data":{"id":171}}                     // 不传
  POST /api/check {"action":"review","data":{"id":171,"approve":"yes"}}
  POST /api/check {"action":"review","data":{"id":171,"approve":2}}
  POST /api/check {"action":"review","data":{"id":171,"approve":false}}
  ```
- 系统回了什么（原始响应）：
  ```json
  // 不传
  {"code":400,"data":null,"message":"请明确选择「通过」或「退回」"}
  // "yes"
  {"code":0,"data":{"approved":false,"adjusted":0},"message":"已退回，库存未做任何调整，请重新盘点后再提交"}
  // 2
  {"code":0,"data":{"approved":false,"adjusted":0},"message":"已退回，库存未做任何调整，请重新盘点后再提交"}
  // false
  {"code":0,"data":{"approved":false,"adjusted":0},"message":"已退回，库存未做任何调整，请重新盘点后再提交"}
  ```
  即：**不传**被正确拦下；而 `"yes"` / `2` 这种「明显是想通过但写错了」的值，和 `false`（真想退回）**返回完全一样**，都被当成退回执行。
- 我认为哪里不对 / 应该是什么样：
  手册第 2.4 节与服务端注释（`check.js:434-436`）都写明「不传 / 传 `"yes"` / 传 2 都按『没表态』拦下」。但 `check.js:437` 只拦 `undefined/null/''`，`:440` 把非 `true/'true'/1/'1'` 的值一律算作「非通过」，于是落进 `:460` 的**退回分支**。老板的审批意图被静默反转。
  正确行为：`"yes"`/`2`/对象等「表错态」的值应**报错拦下**（只有 `true/'true'/1/'1'` 才算通过），绝不能悄悄执行成退回。
- 有没有证据：**有证据**（4 组原始请求+响应 + 代码定位 `check.js:437/440/460`）。

### [P2] `stats.trend` 参数差一位：要 7 天给 8 个点（N+1）

- 我做了什么（原始请求）：
  ```json
  POST /api/stats {"action":"trend","data":{"days":7}}
  ```
- 系统回了什么（原始响应关键字段）：
  ```json
  {"code":0,"data":{"days":7,"list":[{"date":"2026-09-26",...},{"date":"2026-09-27",...},
    ... 共 8 项 ... ,{"date":"2026-10-03",...}]},"message":"操作成功"}
  ```
  `list.length = 8`，日期 `2026-09-26 ~ 2026-10-03`。边界复核：`days=1 → 2 点`、`days=3 → 4 点`，稳定 N+1。
- 我认为哪里不对 / 应该是什么样：
  代码 `stats.js:196` 用 `for (let i = days; i >= 0; i--)` 补齐日期，循环包含 `i=0`，共 `days+1` 个点。看板写「近 7 天」却画 8 天。应正好返回 N 天（`i` 从 `days-1` 到 `0`）。
- 有没有证据：**有证据**（3 组原始响应）。

### [P2] `user.updateRole` 传非法角色时，报错文案误导（「角色不能为空」）

- 我做了什么（原始请求）：
  ```json
  POST /api/user {"action":"updateRole","data":{"id":1,"roles":["superadmin"]}}
  ```
- 系统回了什么（原始响应）：
  ```json
  {"code":400,"data":null,"message":"角色不能为空"}
  ```
  拦截是对的（admin 角色未被改），但提示是「角色不能为空」，而调用方明明传了 `["superadmin"]`。
- 我认为哪里不对 / 应该是什么样：
  `user.js:146` 先按白名单过滤掉非法角色，`["superadmin"]` 被过滤成 `[]`，再触发 `:150` 的「角色不能为空」。用户会以为是「没填」，实际是「填了不支持的角色」。应提示「不支持的角色：superadmin（可选：出库员/采购员/仓管员/老板/管理员）」。
- 有没有证据：**有证据**（原始请求+响应）。

### [P2] `stats.stockFlow` 传不存在的 `material_id` 静默返回空（不提示物料不存在）

- 我做了什么（原始请求）：
  ```json
  POST /api/stats {"action":"stockFlow","data":{"material_id":999999}}
  ```
- 系统回了什么（原始响应）：
  ```json
  {"code":0,"data":{"list":[],"total":0,"page":1,"pageSize":20,"net_quantity":0},"message":"操作成功"}
  ```
- 我认为哪里不对 / 应该是什么样：
  物料不存在时返回 `code:0` + 空流水，老板会误读成「这个物料就是没有流水」。写错一个 `material_id`（如少一位）不会得到任何提示。建议对不存在的物料返回 `404「物料不存在」`，或至少在文案里区分「物料不存在」与「暂无流水」。
- 有没有证据：**有证据**（原始请求+响应）。

---

## 三、越权/乱操作尝试 汇总

> **我一共做了 18 项「乱操作 / 越权 / 边界」尝试，系统拦住 9 项、漏 6 项，另 3 项为按预期执行或中性。**

| 类别 | 项数 | 明细 |
|---|---|---|
| **系统拦住（做对）** | **9** | A1 审核不传 approve 被拦；A7 已完成单再审核被拦；B7 给自己加 admin 被拦；B10 禁用自己被拦；B11 非法角色被拦；C13 不存在 id（盘点/出库）404；C14 无 token 401；C15 伪 token 401；D16 pageSize 封顶 200 |
| **系统漏掉（问题）** | **6** | A3 `approve:"yes"` 未拦（P1）；A4 `approve:2` 未拦（P1）；B8 老板降级 admin（P0）；B9 老板禁用 admin（P0）；B12 老板创建 admin 账号（P0，且 `approve` 入口同样可授 admin）；D17 `trend` N+1（P2） |
| **按预期正常执行** | **2** | A5 `approve:false` 正确退回；A6 `approve:true` 正确通过 |
| **中性（无对错）** | **1** | D18 不存在物料返回空流水 |

**红线结论：6 项漏洞里有 5 项集中在「权限」上（B8/B9/B12 三项 P0 + A3/A4 两项审批语义），属于本轮最严重的一类。** 尤其 B8/B9/B12：老板（非管理员）能降级/禁用/创建管理员，说明「admin 专属能力」的护栏只在 `updateRole` 的部分路径生效。

---

## 四、审批参数实测对照表（不传 / `"yes"` / `2` / `false` 各返回什么）

测试对象：`CHK-20261003-007`（id=171，待审核，物料 2100 实盘=账面、差异 0）

| 传入 `approve` | 原始响应 | 返回语义 | 状态变化 | 是否符合手册预期 |
|---|---|---|---|---|
| **不传** | `{"code":400,"message":"请明确选择「通过」或「退回」"}` | **报错拦下** | `pending_review` 不变 | ✅ 符合 |
| `"yes"` | `{"code":0,"data":{"approved":false,"adjusted":0},"message":"已退回，库存未做任何调整，请重新盘点后再提交"}` | **静默「退回」** | `pending_review → in_progress` | ❌ 不符（应报错拦下） |
| `2` | `{"code":0,"data":{"approved":false,"adjusted":0},"message":"已退回，库存未做任何调整，请重新盘点后再提交"}` | **静默「退回」** | `pending_review → in_progress` | ❌ 不符（应报错拦下） |
| `false` | `{"code":0,"data":{"approved":false,"adjusted":0},"message":"已退回，库存未做任何调整，请重新盘点后再提交"}` | **「退回」**（正确） | `pending_review → in_progress` | ✅ 符合 |
| `true`（对照） | `{"code":0,"data":{"approved":true,"adjusted":0,"details":[]},"message":"审核完成，账实相符，无需调整"}` | **「通过」** | `pending_review → completed` | ✅ 符合 |

**一句话结论**：`"yes"` 与 `2` 的返回和 `false` **一字不差**，都是「已退回」。老板若把「通过」误写成 `"yes"`（字符串）或 `2`（数字），系统不会报错，会直接当成「退回」把单打回重盘 —— 审批意图被静默反转。

---

## 五、系统做对的地方（≥3 条）

1. **审核「不表态」的底线守住了**：`check.review` 不传 `approve` 时被明确拦下（`code=400「请明确选择「通过」或「退回」」`），**没有出现「默认通过」**。盘盈盘亏会动物流账，这条底线本轮依然在线，是本次最重要的正确点。
2. **自我提权被精准挡住**：老板给自己加 `admin` 返回 `code=403「只有「管理员」才能授予「管理员」角色」`，且角色未被改动（回查仍 `["boss"]`）。说明「授予 admin」这条边界本身是有效的。
3. **已完成单不能被重复审核**：对 `completed` 的单再调 `review` 返回 `code=400「当前状态「已完成」不支持审核」`，没有重复调账。
4. **不能禁用自己**：`user.disable{id:29}`（自己）返回 `code=400「不能禁用自己的账号」`，防呆到位。
5. **鉴权在传输层就挡住**：不带 token → `code=401「请先登录」`；伪造 token → `code=401「登录已过期，请重新登录」`；两者都没有泄露任何数据（`data:null`）。
6. **不存在的资源报 404 而非空对象**：`check.detail{999999}` → `404「盘点任务不存在」`，`outbound.detail{999999}` → `404「单据不存在」`，不会把「查不到」伪装成「查询成功」。
7. **分页上限硬性封顶**：`stats.warning{pageSize:500}` 被 `paging()` 收敛为 `pageSize:200`（`format.js:91-96`），不会因超大 `pageSize` 把库拖垮。
8. **同物料不能同时在两张盘点单**：我本想直接对 id170 的物料再建盘点单，发现物料 2105/2112 已被 id170 占用、2100 未被占用，自建单只放 2100 即通过 —— 冲突约束与「未完成单占用」语义一致，未串数据。

---

## 六、数据恢复清单（我发现并恢复的所有改动）

| 步骤 | 被改动的对象 | 改成了什么 | 是否恢复 | 恢复方式 |
|---|---|---|---|---|
| B8 | **admin(id=1)** roles | `["admin","boss"] → ["out"]` | ✅ 已恢复为 `["admin","boss"]` | `user.approve{id:1,roles:["admin","boss"],warehouse_ids:[]}` |
| B9 | **admin(id=1)** status | `active → disabled` | ✅ 已恢复为 `active` | `user.enable{id:1}` |
| B12 | 新建账号 **id=52** `V3R2_audit_1791028547046` | 创建为 `["admin"]`/active | ⚠️ 系统无删除接口 → 已 `updateRole→["out"]` + `disable`（文件末态：`roles:["out"]`、`status:disabled`） | `user.updateRole` + `user.disable` |
| A | 自建盘点单 **CHK-20261003-007**（id=171） | 建单→提交→审核为 `completed` | ⚠️ 已完成的盘点单**不可作废**（系统限制），保留为 `[V3-R2]` 标记测试单；**差异 0，未改任何库存**（`adjust：0`） | 无（不动物流账） |

> 最终兜底校验（脚本 `finally`）：`admin(id=1)` = `roles:["admin","boss"], status:active` ✅；`dev_boss(id=29)` = `roles:["boss"], status:active` ✅。除上述标记数据外，未改动任何非测试数据。

---

## 七、我这个岗位愿不愿意继续用 / 敢不敢签字

**结论：不敢签字。**

第 1 轮我卡在「审批语义被反转 + 收不到待审通知」；这一轮我专门来试「乱搞」，结果发现**权限护栏比第 1 轮看到的更松**：

- 我一个老板账号，能**把系统管理员降级**（B8）、**把系统管理员禁用**（B9）、**直接造一个管理员账号**（B12）。这三条放任何一家公司都是红线 —— 老板不该有「凭空制造/瘫痪管理员」的能力，否则「管理员」这个角色形同虚设。
- 加上审批参数 `"yes"`/`2` 会把「通过」变成「退回」（P1），审批这条链路我依然不敢在上面签字。

**我认可的地方**：数字账（第 1 轮已验，本轮抽查仍准）、鉴权（401/404 干脆）、防自锁（不能禁自己）、分页封顶，这些都是好设计，改的时候别误伤。

**我敢签字的前置条件**：
1. B8/B9/B12 三条 P0：管理账号（admin/boss）的角色/状态变更、以及任何带 `admin` 的出账号操作，一律要求调用者本人是 admin；`create`/`approve` 补上与 `updateRole` 相同的授权边界。
2. A3/A4（P1）：`approve` 只认 `true/'true'/1/'1'`，其余值（含 `"yes"`、`2`、对象）**报错拦下**，不得静默执行成退回。
3. D17（P2）顺手修掉（`trend` 返回正好 N 天）。

**修完这三类，我签字。** 在那之前，账我可以看，但这份「上线同意」的签字，我不落笔。
