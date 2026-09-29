# 胜龙进销存系统 · 后端自建服务器方案

> **版本**：v3.0（替代 v2.x 的微信云开发方案）
> **变更日期**：2026-09-29
> **变更原因**：个人主体小程序未认证，无法开通微信云开发 → 后端改为**自建服务器**
> **交付形态**：**本地 Docker 一键起 → 验证通过 → 整体搬到服务器**

---

## 一、结论摘要（先看这段）

**这件事能做，而且对项目是好事。** 三点结论：

1. **可行**：后端换成自建服务，小程序和后台的功能一个都不会少，反而摆脱了云开发的配额限制和平台绑定。
2. **改动可控**：因为现有代码的调用方式是统一的（`模块 + 动作 + 数据`），前端业务页面**几乎不用改**，主要工作量集中在后端把「云数据库查询」换成「MySQL 查询」。
3. **本地能验证**：本地用 Docker 起一套完整环境（数据库 + 接口服务），跑通全部功能、导入你的真实 1930 条物料，确认无误后再搬到服务器。**不会出现"上线才知道有问题"**。

| 项目 | 原方案（云开发） | 新方案（自建） |
|---|---|---|
| 后端运行位置 | 腾讯云函数 | **自己的服务器（Docker 容器）** |
| 数据库 | 云数据库（文档型） | **MySQL 8（Docker 容器）** |
| 用户身份 | 云函数白送 openid | **自己用 code 换 openid** |
| 文件存储 | 云存储 | **服务器本地目录 + Nginx** |
| 每月成本 | 免费额度内 0 元 | **服务器已付费，边际成本 0** |
| 谁能开 | 个人主体**开不了** ❌ | **任何主体都能开** ✅ |

---

## 二、新旧架构对比

### 2.1 原来（云开发）——走不通

```
小程序 ──callFunction──▶ 云函数(腾讯云) ──▶ 云数据库
Web后台 ──HTTP触发器──▶ 云函数          ──▶ 云存储
                              ▲
                         身份由云平台自动注入
```

**卡点**：个人主体小程序未认证 → 云开发控制台打不开 → 这条路彻底堵死。

### 2.2 现在（自建服务器）

```
                        ┌─────────────────────────────────────┐
                        │        你自己的服务器 / Docker       │
微信小程序 ──HTTPS──▶  Nginx ──▶ Node 接口服务 ──▶ MySQL 8    │
Web 后台   ──HTTPS──▶          (Express)      ──▶ 本地文件存储 │
                        └─────────────────────────────────────┘
                                    ▲
                              身份由自己签发(JWT)
```

**本地开发时**：上面这套完整跑在你自己电脑的 Docker 里，一模一样。

### 2.3 关键设计：**接口契约一个字都不改**

这是本方案最重要的一个决定。看现在的调用方式：

```javascript
// 小程序现在这样调（云函数）
wx.cloud.callFunction({ name: 'outbound', data: { action: 'submit', data: {...} } })

// Web 后台现在这样调（HTTP）
POST /functions/outbound  { action: 'submit', data: {...} }
```

**新方案保留这个形状不变**，只是把「函数名」变成「URL 路径」：

```javascript
// 小程序改后（自己服务器）
POST https://你的域名/api/outbound   { action: 'submit', data: {...} }

// Web 后台改后
POST https://你的域名/api/outbound   { action: 'submit', data: {...} }
```

返回格式也**完全不变**：`{ code: 0, data: {...}, message: '...' }`

**这意味着什么**：

| 改动范围 | 工作量 |
|---|---|
| 小程序业务页面（15 个页面） | **0 改动** |
| Web 后台业务页面（14 个页面） | **0 改动** |
| 小程序调用封装 | 只改 `utils/cloud.js` **1 个文件** |
| Web 后台调用封装 | 只改 `admin/src/api/index.js` **1 个文件**（改个地址） |
| 后端数据层 | **主要工作量在这**（云数据库 → MySQL） |

---

## 三、技术选型

| 层 | 选型 | 为什么 |
|---|---|---|
| 接口服务 | **Node.js 20 + Express** | 现有云函数就是 Node，业务逻辑可直接复用，不用换语言重写 |
| 数据库 | **MySQL 8** | 进销存最怕"库存算错"。MySQL 的事务 + 行锁是解决这个问题的标准做法：两个人同时出库同一物料，数据库会排队，不会出现负库存或算重 |
| 身份认证 | **JWT（自签令牌）** | 登录一次发个令牌，后续请求带着走。不依赖任何第三方平台 |
| 部署 | **Docker Compose** | 本地和服务器**环境完全一致**，一句命令起全站，换服务器只需搬目录、改配置 |
| 反向代理 | **Nginx + HTTPS** | 小程序硬性要求 HTTPS，Nginx 负责证书和转发 |
| 定时任务 | **node-cron**（服务内置） | 库存预警扫描、每日自动备份，原来靠云函数定时器，现在自己跑 |

**为什么不用 SQLite / MongoDB？**

- SQLite：更轻，但多人同时写入时容易排队等待，进销存这种"多人抢着出库"的场景有风险。
- MongoDB：代码改起来最省事，但内存占用高，且库存强一致场景不如 MySQL 直观。
- **MySQL 8**：两头都占，且你以后找运维、招人接手都最容易。

> 数据访问层会做成独立一层（Repository），万一将来要换数据库，只改这一层，业务逻辑不动。

---

## 四、云开发原本白送的 4 件事，现在要自己实现

这 4 件事是整个改造的核心，也是风险所在，逐条说清楚。

### 4.1 用户身份（openid 获取）—— **最关键**

**原来**：云函数里一行 `cloud.getWXContext().OPENID` 就拿到用户身份，平台帮你做了全部校验。

**现在**要走微信官方的标准流程：

```
小程序                        自己的后端                    微信服务器
   │                              │                             │
   │─ wx.login() 拿到 code ──────▶│                             │
   │                              │─ code + AppID + AppSecret ─▶│
   │                              │◀──── openid + session_key ──│
   │                              │                             │
   │                              │  查数据库这个 openid 是谁     │
   │◀──── 签发 JWT 令牌 ──────────│                             │
   │                              │                             │
   │─ 之后每次请求带 JWT ─────────▶│  验令牌 → 知道你是谁          │
```

**需要你提供**：小程序的 **AppSecret**（在微信公众平台 → 开发 → 开发设置 → 生成）。这个密钥只存在服务器上，绝不写进小程序代码。

### 4.2 数据库

云数据库的文档型查询（`db.collection('users').where({openid}).get()`）要改写成 SQL（`SELECT * FROM users WHERE openid = ?`）。

涉及 **7 个模块、35 个动作**，是最主要的工作量。

### 4.3 文件存储

云存储的 `uploadFile` 换成自建上传接口，文件存到服务器目录，通过 Nginx 提供访问。工作量小。

### 4.4 HTTPS 证书

小程序**强制要求** HTTPS，且域名必须**已备案**（这是死规定，绕不过）。

你已确认有另外的服务器和域名 → 部署时用 Let's Encrypt 免费证书（自动续期），零成本。

---

## 五、数据库表设计（10 张表）

原设计是 10 个"集合"，关系型需要做 3 处结构调整：

1. **盘点明细拆分**：原来 `stock_checks.items` 是内嵌数组 → 拆成独立的 `stock_check_items` 表（一条物料一行，方便统计差异）
2. **数组字段用 JSON 存**：`roles`（角色数组）、`warehouse_ids`（仓库权限）保持 JSON 类型，读写方式和原来一致
3. **主键统一**：内部用自增数字主键，**但接口返回时统一叫 `_id`**（保持前端零改动）

### 5.1 表清单

| # | 表名 | 说明 | 对应原集合 |
|---|---|---|---|
| 1 | `users` | 用户与角色 | users |
| 2 | `materials` | 物料档案 | materials |
| 3 | `warehouses` | 仓库（配件仓/成品仓） | warehouses |
| 4 | `outbound_orders` | 出库单 | outbound_orders |
| 5 | `inbound_orders` | 入库单 | inbound_orders |
| 6 | `stock_checks` | 盘点单（主表） | stock_checks |
| 7 | `stock_check_items` | 盘点明细（**新拆出**） | stock_checks.items |
| 8 | `stock_logs` | 库存流水 | stock_logs |
| 9 | `suppliers` | 供应商 | suppliers |
| 10 | `operation_logs` | 操作日志 | operation_logs |
| 11 | `settings` | 系统配置 | settings |

### 5.2 关键表结构

**users（用户）**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | BIGINT PK | 自增主键 |
| openid | VARCHAR(64) UNIQUE | 微信唯一标识 |
| username | VARCHAR(50) UNIQUE NULL | 后台账号（Web后台登录用） |
| password_hash | VARCHAR(255) NULL | 后台密码（bcrypt 加密） |
| real_name / phone / nickname / avatar | VARCHAR | 基本资料 |
| roles | JSON | 角色数组 `["out","in"]` |
| warehouse_ids | JSON | 可操作的仓库 |
| status | ENUM | pending / active / disabled |
| created_at / last_login_at | DATETIME | |

**materials（物料）** —— 核心表

| 字段 | 类型 | 说明 |
|---|---|---|
| id | BIGINT PK | |
| name / category / spec / unit / barcode | VARCHAR | 基本属性 |
| warehouse_id | BIGINT FK | **所属仓库**（配件仓/成品仓） |
| current_stock | DECIMAL(14,3) | 当前库存（用小数，避免精度丢失） |
| warning_stock | DECIMAL(14,3) | 预警库存 |
| avg_cost | DECIMAL(14,4) | 移动加权平均成本 |
| is_deleted | TINYINT | 软删除 |
| **UNIQUE KEY** | (name, spec, warehouse_id) | **防重复建档** |

**outbound_orders / inbound_orders（单据）**

在原有字段基础上**新增 3 个关键字段**（云开发版遗漏的）：

| 新增字段 | 类型 | 作用 |
|---|---|---|
| `client_request_id` | VARCHAR(64) **UNIQUE** | **幂等键**：网络卡顿重复提交时，数据库直接拦掉，不会出两次库 |
| `warehouse_id` | BIGINT | 多仓库支持 |
| `confirmed_at` / `confirmed_by` | DATETIME / VARCHAR | 仓管确认环节的时间与确认人 |

**stock_logs（库存流水）** —— 审计命脉

每笔库存变动都留痕：`变动前库存` → `变动后库存`，出了纠纷能一路追溯。索引：`(material_id, created_at)`。

### 5.3 库存变更的标准做法（防算错的核心）

所有涉及库存的操作，**必须**走同一个套路：

```sql
START TRANSACTION;
  -- 1. 锁定这一行（其他人此时只能排队等）
  SELECT current_stock, avg_cost FROM materials WHERE id = ? FOR UPDATE;
  -- 2. 校验（够不够出、是否已作废）
  -- 3. 更新库存
  UPDATE materials SET current_stock = current_stock - ? WHERE id = ?;
  -- 4. 写流水（记录变动前后值）
  INSERT INTO stock_logs (...) VALUES (...);
  -- 5. 更新单据状态
COMMIT;
```

**任何一步失败，整笔回滚**，绝不会出现"库存扣了但单据没生成"。

---

## 六、后端目录结构

```
shenglong-erp/
├── server/                          # ★ 新增：后端服务
│   ├── src/
│   │   ├── app.js                   # Express 入口
│   │   ├── db/
│   │   │   ├── pool.js              # MySQL 连接池
│   │   │   ├── schema.sql           # 建表语句
│   │   │   └── seed.js              # 初始化数据（仓库、管理员、配置）
│   │   ├── middleware/
│   │   │   ├── auth.js              # JWT 校验
│   │   │   ├── permission.js        # 角色权限
│   │   │   ├── idempotent.js        # 幂等拦截
│   │   │   └── errorHandler.js      # 统一错误处理
│   │   ├── modules/                 # ★ 7 个业务模块（对应原云函数）
│   │   │   ├── auth.js
│   │   │   ├── material.js
│   │   │   ├── outbound.js
│   │   │   ├── inbound.js
│   │   │   ├── check.js
│   │   │   ├── stats.js
│   │   │   └── user.js
│   │   ├── services/
│   │   │   ├── wechat.js            # code2session 封装
│   │   │   ├── stock.js             # 库存变更统一出口（事务+流水）
│   │   │   └── orderNo.js           # 单号生成
│   │   └── jobs/
│   │       ├── warning.js           # 库存预警扫描
│   │       └── backup.js            # 每日备份
│   ├── Dockerfile
│   ├── .env.example
│   └── package.json
├── docker-compose.yml               # ★ 一键起全套（mysql + api）
├── miniprogram/                     # 小程序（业务页面不动）
├── admin/                           # Web 后台（业务页面不动）
└── docs/
```

---

## 七、本地开发环境（你要"先本地做好"的部分）

### 7.1 一条命令起全站

```bash
cd G:/sl/shenglong-erp
docker compose up -d          # 起 MySQL + 接口服务
docker compose exec api npm run db:init    # 建表 + 初始化
docker compose exec api npm run import     # 导入 1930 条真实物料
```

起来之后：

| 服务 | 地址 | 用途 |
|---|---|---|
| 接口服务 | http://localhost:3000/api | 小程序和后台都调它 |
| MySQL | localhost:3306 | 数据库 |
| Web 后台 | http://localhost:5173 | 后台开发预览 |

### 7.2 小程序在本地怎么连

微信开发者工具 → 右上角「详情」→「本地设置」→ 勾选 **「不校验合法域名、web-view、TLS 版本以及 HTTPS 证书」**。

勾上之后，小程序就能直接连本地 `http://localhost:3000`，开发阶段不需要域名和证书。

> **真机预览的注意点**：手机连不上电脑的 `localhost`。真机测试时需要把接口地址改成**电脑的局域网 IP**（如 `http://192.168.1.5:3000`），或者用内网穿透工具。这一点我会在代码里做成**可配置的一处开关**。

### 7.3 部署到服务器时改什么

只改 **1 个配置文件**（`.env`）里的域名、数据库密码、AppSecret，然后：

```bash
docker compose up -d --build
```

---

## 八、改造工作量评估

| 工作项 | 内容 | 比重 |
|---|---|---|
| 后端服务骨架 | Express + 路由分发 + 连接池 + 中间件 + Docker | 15% |
| **业务模块数据层迁移** | **7 个模块 35 个动作，云数据库 → MySQL** | **45%** |
| 认证与权限 | code2session + JWT + 6 种角色 + 仓库级数据权限 | 15% |
| 库存事务与幂等 | 行锁事务、流水、移动加权成本、幂等键 | 10% |
| 前端传输层 | 小程序 1 个文件 + 后台 1 个文件 | 5% |
| 本地跑通与数据导入 | Docker 编排、建表、1930 条真实数据 | 5% |
| 端到端验证 | 35 个接口 + 4 角色 × 3 轮回归 | 5% |

**最大的一块是数据层迁移**，但它是"照着原有业务逻辑翻译"，逻辑已有、不需要重新设计，属于体力活而非难题。

---

## 九、任务拆解

| # | 任务 | 产出 |
|---|---|---|
| 1 | 编写后端自建方案（本文档） | docs/BACKEND-PLAN.md |
| 2 | 更新 DEVELOPMENT.md / tasks.md | 方案文档同步 |
| 3 | 搭建后端骨架 | server/ 可启动、健康检查通过 |
| 4 | 认证模块 | 小程序 + 后台都能登录 |
| 5 | 迁移 7 个模块数据层 | 35 个动作全部可用 |
| 6 | 前端传输层改造 | 小程序/后台连上自己的接口 |
| 7 | 本地跑通 + 导入真实数据 | 1930 条物料进库 |
| 8 | 端到端验证 + 多角色回归 | 测试报告 |

---

## 十、部署方案（预置，本地验证通过后执行）

### 10.1 服务器准备清单

| 项 | 要求 | 说明 |
|---|---|---|
| 服务器 | Linux（Ubuntu 22.04+ / CentOS 7+），**2核4G 起建议** | 跑 MySQL + Node + Nginx |
| 域名 | **已备案** | 小程序硬性要求，必须有 |
| HTTPS | Let's Encrypt 免费证书 | 自动续期 |
| 软件 | Docker + Docker Compose | 一条命令装 |

### 10.2 上线步骤（本地验证通过后）

1. 服务器装 Docker
2. 上传项目（只传 `server/` + `docker-compose.yml` + Nginx 配置）
3. 改 `.env`（域名、数据库密码、AppSecret）
4. `docker compose up -d --build`
5. 配 Nginx 反代 + 申请 HTTPS 证书
6. 微信公众平台 → 开发设置 → **服务器域名** → 填 `https://你的域名`（request 合法域名）
7. 小程序真机测试 → 正式使用

### 10.3 数据备份

MySQL 容器每日自动 `mysqldump` 到宿主机目录，保留 30 天；同时支持一键导出全部业务数据为 CSV。

---

## 十一、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **必须拿到 AppSecret** | 拿不到就无法实现小程序登录 | 这是唯一的硬性前置条件，微信公众平台可自助生成 |
| 域名未备案 | 小程序无法请求线上接口 | 开发阶段用"不校验合法域名"绕过；正式上线前必须备案（约 2-3 周，建议提前启动） |
| 真机连不上本地服务 | 真机无法调试 | 用局域网 IP 或内网穿透；代码中接口地址做成一处开关 |
| 服务器单点故障 | 服务器挂 = 系统不可用 | Docker 每日自动备份；数据可随时导出，不会被平台锁死 |
| 库存并发算错 | 账实不符 | 全部走行锁事务，这是本方案相对云开发版的**增强**，不是退步 |
| 服务器安全 | 被入侵 | 只暴露必要端口、数据库不对外、SSH 密钥登录、定期更新 |

---

## 十二、需要你提供 / 确认的事项

| # | 事项 | 什么时候要 | 说明 |
|---|---|---|---|
| 1 | **AppSecret** | 做到登录功能时 | 微信公众平台 → 开发管理 → 开发设置 → AppSecret（生成后只会显示一次） |
| 2 | 服务器规格 | 部署时 | 2核4G 以上更稳 |
| 3 | 域名 | 部署时 | 需已备案 |
| 4 | 后台初始管理员账号 | 现在可以先定 | 默认 `admin / 首次登录改密码` |

> 除 AppSecret 外，其余都不阻塞开发。**现在就可以先把后端全部做完并在本地验证。**

---

## 十三、与旧方案的差异清单（改动一览）

| 项目 | 旧（云开发） | 新（自建） |
|---|---|---|
| 小程序调用 | `wx.cloud.callFunction` | `wx.request` → `/api/{module}` |
| 云函数 | `exports.main(event)` | Express 路由 + 模块分发（**签名保持一致**） |
| 数据库 | 云数据库 10 个集合 | MySQL 11 张表 |
| 用户身份 | 平台注入 openid | `code2session` + JWT |
| 权限 | 前端 + 云函数内判断 | JWT + 角色中间件 + 仓库数据权限 |
| 幂等 | 应用层去重 | **数据库唯一索引**（更可靠） |
| 库存并发 | 依赖平台 | **行锁事务**（更强） |
| 文件存储 | 云存储 | 本地目录 + Nginx |
| 定时任务 | 云函数定时触发器 | node-cron |
| 部署 | 上传云函数 | Docker Compose |
| 运维 | 腾讯云控制台 | 自己的服务器 + 每日自动备份 |

---

**方案确认后即进入开发，按第九章顺序推进，全程在本地验证。**
