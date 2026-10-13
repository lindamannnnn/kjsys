# 胜龙进销存 - 完整部署清单

## 云函数部署清单

| 顺序 | 云函数 | 目录 | 状态 |
|------|--------|------|------|
| 1 | init-db | deploy/cloudfunctions/init-db/ | ✅ 已部署 |
| 2 | auth | deploy/cloudfunctions/auth/ | ⏳ 待部署 |
| 3 | material | deploy/cloudfunctions/material/ | ⏳ 待部署 |
| 4 | outbound | deploy/cloudfunctions/outbound/ | ⏳ 待部署 |
| 5 | inbound | deploy/cloudfunctions/inbound/ | ⏳ 待部署 |
| 6 | check | deploy/cloudfunctions/check/ | ⏳ 待部署 |
| 7 | stats | deploy/cloudfunctions/stats/ | ⏳ 待部署 |
| 8 | user | deploy/cloudfunctions/user/ | ⏳ 待部署 |

---

## 部署步骤

### 第 1 步：执行数据库初始化（已部署的 init-db）

在云开发控制台 → 云函数 → init-db → 云端测试：

```json
{
  "action": "fullInit"
}
```

### 第 2 步：部署 auth 云函数

1. 云开发 → 云函数 → 新建云函数
2. 名称：`auth`
3. 上传 `deploy/cloudfunctions/auth/` 目录下的文件
4. 上传并部署

### 第 3 步：部署 material 云函数

1. 云开发 → 云函数 → 新建云函数
2. 名称：`material`
3. 上传 `deploy/cloudfunctions/material/` 目录下的文件
4. 上传并部署

### 第 4 步：部署 outbound 云函数

1. 云开发 → 云函数 → 新建云函数
2. 名称：`outbound`
3. 上传 `deploy/cloudfunctions/outbound/` 目录下的文件
4. 上传并部署

### 第 5 步：部署 inbound 云函数

1. 云开发 → 云函数 → 新建云函数
2. 名称：`inbound`
3. 上传 `deploy/cloudfunctions/inbound/` 目录下的文件
4. 上传并部署

### 第 6 步：部署 check 云函数

1. 云开发 → 云函数 → 新建云函数
2. 名称：`check`
3. 上传 `deploy/cloudfunctions/check/` 目录下的文件
4. 上传并部署

### 第 7 步：部署 stats 云函数

1. 云开发 → 云函数 → 新建云函数
2. 名称：`stats`
3. 上传 `deploy/cloudfunctions/stats/` 目录下的文件
4. 上传并部署

### 第 8 步：部署 user 云函数

1. 云开发 → 云函数 → 新建云函数
2. 名称：`user`
3. 上传 `deploy/cloudfunctions/user/` 目录下的文件
4. 上传并部署

---

## 数据库索引创建

在云开发控制台 → 数据库 → 索引管理：

### users 集合
- openid: 唯一索引
- status: 普通索引
- roles: 普通索引

### materials 集合
- warehouse_id: 普通索引
- category: 普通索引
- name: 普通索引

### outbound_orders 集合
- order_no: 唯一索引
- status: 普通索引
- operator_openid: 普通索引
- created_at: 普通索引

### inbound_orders 集合
- order_no: 唯一索引
- status: 普通索引
- operator_openid: 普通索引
- supplier: 普通索引
- created_at: 普通索引

### stock_checks 集合
- check_no: 唯一索引
- status: 普通索引
- assignee_openids: 普通索引

### stock_logs 集合
- material_id: 普通索引
- created_at: 普通索引
- related_order_id: 普通索引

### operation_logs 集合
- openid: 普通索引
- created_at: 普通索引

---

## 验证清单

- [ ] 8 个云函数全部部署
- [ ] 数据库初始化完成（fullInit）
- [ ] 10 个集合全部创建
- [ ] 索引全部创建
- [ ] 仓库数据 2 条
- [ ] 供应商数据 5 条
- [ ] 系统设置 1 条
- [ ] 物料数据 1930 条

---

## 测试清单

- [ ] 小程序登录正常
- [ ] 出库功能正常
- [ ] 入库功能正常
- [ ] 盘点功能正常
- [ ] 老板看板数据正常
- [ ] Web 后台登录正常
- [ ] Web 后台数据正常

---

**部署完成后，系统就可以正式使用了。**

---

# ⛔ 生产环境数据安全红线（2026-10-12 新增，必读）

> 背景：2026-10-12 发生过一次**清理脚本误删真实单据**的事故。事后已加装硬性保护，
> 但**生产部署时仍必须逐项确认**下面几条，否则保护形同虚设。

## 一、必须确认的环境变量

| 变量 | 生产要求 | 说明 |
|---|---|---|
| `NODE_ENV` | `production` | 生产环境**必须**是 production。为 production 时，任何破坏性脚本/硬删除 SQL **一律被拒绝**，无绕过手段 |
| `ALLOW_DESTRUCTIVE` | **不要出现 / 设为 0** | 破坏性脚本的总开关。**只在开发机**设为 1。生产若误设为 1，虽然 `NODE_ENV=production` 那层仍会拦住，但绝不应依赖兜底 |
| `ALLOW_DEV_LOGIN` | `false` | 否则任何人可拿测试身份登录 |

## 二、部署后自检（务必执行）

```bash
cd /opt/shenglong/server

# 1. 确认环境标识正确
grep -E '^(NODE_ENV|ALLOW_DESTRUCTIVE|ALLOW_DEV_LOGIN)' .env

# 2. 安全闸门自检：应全部通过（其中「生产环境发 DELETE 被拦截」必须为 ✅）
npm run test:security
```

## 三、⛔ 绝对禁止在生产执行的脚本

以下脚本会**物理删除或批量改写数据**，只允许在开发机跑（生产环境执行会被闸门拒绝，但请不要尝试）：

- `tests/cleanup-test-data.js`、`tests/v2-test-cleanup.js`
- `tests/audit-cleanup.js`、`tests/user-test-cleanup.js`（**会清空整张单据/流水表**）
- `scripts/seed-sim-stock.js`（模拟数据灌入）
- `src/db/apply-material-code.js`、`src/db/apply-subcategory.js`（一次性数据修复）
- 任何 `tests/` 下的测试套件

**生产允许执行的数据库脚本**（幂等、非破坏）：
`npm run db:init`、`npm run db:seed`、`npm run import:materials`、`npm run db:migrate*`、`npm run db:reset-admin`

## 四、保护机制说明

破坏性操作有三层保护，缺一不可：

1. **脚本层**：破坏性脚本入口调用 `assertDestructive()`，不满足条件直接退出（exit 2），**一个字节都不写**。
2. **连接池层**（真防线，绕不过）：`src/db/pool.js` 拦截所有 `DELETE FROM` / `TRUNCATE` / `DROP TABLE` 语句 —— 本系统的**业务代码零硬删除**（全部软删除 `is_deleted=1`），所以此拦截**不会误伤任何正常业务**。
3. **回归测试**：`npm run test:security` 锁死上述机制，防止将来被改坏。

⚠️ 若要临时在生产执行一次性数据修复，正确做法是**先备份全库**，再临时设置 `ALLOW_DESTRUCTIVE=1` 执行，**执行完立即改回 0**。

