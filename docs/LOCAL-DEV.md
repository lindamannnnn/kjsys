# 胜龙进销存 · 本地运行手册

> **适用**：本地开发、调试、测试
> **目标**：三条命令把整套系统跑起来
> **更新日期**：2026-09-29

---

## 一、环境准备（只需一次）

| 软件 | 版本要求 | 检查命令 |
|---|---|---|
| Docker Desktop | 已安装并**启动** | `docker ps` |
| Node.js | 20 或以上 | `node -v` |
| 微信开发者工具 | 最新版 | — |

> ⚠️ **Docker 必须处于「已启动」状态**（托盘图标不再是灰的）。`docker ps` 能列出容器才算就绪。

---

## 二、启动全套（每次开发）

### 第 1 步：启动数据库

```bash
cd G:/sl/shenglong-erp
docker compose up -d mysql
```

确认健康状态（应显示 `healthy`）：

```bash
docker compose ps
```

### 第 2 步：启动后端接口服务

```bash
cd G:/sl/shenglong-erp/server
npm start
```

看到下面这些就算成功：

```
[数据库] 连接成功
  胜龙进销存系统 · 后端接口服务已启动
  地址: http://0.0.0.0:3000
  健康检查: http://127.0.0.1:3000/api/health
  模块: auth, material, outbound, inbound, check, stats, user, supplier, warehouse, upload
```

浏览器访问 http://localhost:3000/api/health 应返回 `{"code":0,...}`。

### 第 3 步：启动 Web 后台

```bash
cd G:/sl/shenglong-erp/admin
npm run dev
```

访问 http://localhost:5173 ，用 `admin / admin123456` 登录。

### 第 4 步：运行小程序

```bash
cd G:/sl/shenglong-erp/miniprogram
npm run build:mp-weixin      # 或用 npm run dev:mp-weixin 开发模式
```

然后用**微信开发者工具**打开目录：

```
G:/sl/shenglong-erp/miniprogram/dist/build/mp-weixin
```

> ⚠️ **别选上一层 `miniprogram/`**。
> uni-app 的源码根目录里只有 `src/pages.json`，**没有 `app.json`**；
> 用开发者工具导入源码根目录会报
> 「**Error: app.json 在项目根目录未找到 app.json**」，
> 模拟器起不来。编译产物在 `dist/build/mp-weixin/` 下，那里才有 `app.json`。

不想每次手敲路径的话：

```bash
npm run mp:open     # 自动用开发者工具打开正确的产物目录
```

> 它靠开发者工具的 `cli.bat` 工作，需要先在
> **工具 → 设置 → 安全设置 → 服务端口** 里打开该开关；
> 没开的话脚本会明确告诉你，并给出手动导入的路径。
>
> **兜底机制**：`miniprogram/project.config.json` 里已经写了
> `"miniprogramRoot": "dist/build/mp-weixin/"`，
> 所以即使真的导入到了 `miniprogram/` 那一层，工具也能顺着找到产物。
> 两条路都通，不用纠结选哪个入口。

---

## 三、小程序必须做的一项设置

微信开发者工具 → 右上角「**详情**」→「**本地设置**」→ 勾选：

- ☑ **不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书**

勾上之后，小程序才能连本地 `http://localhost:3000`。

> **真机预览注意**：手机连不上电脑的 `localhost`。真机测试时要把
> `miniprogram/src/utils/cloud.js` 里的 `API_BASE` 改成电脑的局域网 IP，
> 例如 `http://192.168.1.5:3000`，并确保手机和电脑在同一 WiFi 下。

---

## 四、登录方式（两种）

### 方式 A：开发者模式（当前默认，无需 AppSecret）

`miniprogram/src/utils/cloud.js` 中：

```js
export const DEV_MODE = true        // 跳过微信登录，直接用测试身份
const DEV_OPENID = 'dev_worker_01'  // 默认身份，可在「我的」页面里换
```

后端 `.env` 中需有：

```ini
ALLOW_DEV_LOGIN=true
```

#### 开发身份有哪些、怎么切换

先建好身份（只需跑一次）：

```bash
npm run seed:dev
```

它会创建 6 个账号，每个都配好角色和可管仓库：

| 登录标识 | 姓名 | 角色 | 能看到的界面 |
|---|---|---|---|
| `dev_worker_01` | 开发·全能 | 出库+入库+仓管+采购 | 出库/入库/盘点/流水都能进 |
| `dev_out` | 开发·出库员 | out | 提交出库单 |
| `dev_in` | 开发·入库员 | in | 提交入库单 |
| `dev_sk` | 开发·仓管 | storekeeper | 确认/驳回单据、盘点 |
| `dev_purchase` | 开发·采购 | purchase | 采购入库、库存流水对账 |
| `dev_boss` | 开发·老板 | boss | 看板、预警、全部单据 |

> **为什么需要这一步**：后端遇到没见过的 openid 会自动建档，
> 但角色是空的、状态是 `pending`，于是小程序"能启动但什么都看不到"。
> 这个脚本就是把这些开发身份预先建好并给足权限。

切换身份有两种方式：

1. **在模拟器里点**（推荐）：小程序「我的」页面 → 「开发身份」→ 点某个身份，
   会自动重新登录并跳回首页。**不用改代码、不用重新编译。**
2. 改 `cloud.js` 里的 `DEV_OPENID` 后重新编译。

> 想再加身份：改 `server/src/db/seed-dev.js` 的 `DEV_USERS` 数组 →
> 重跑 `npm run seed:dev` → 在 `cloud.js` 的 `DEV_IDENTITIES` 里补一条。
>
> ⚠️ 上线前必须删掉这些身份：`npm run audit:data` 会按 `dev_` 前缀把它们列出来；
> 同时把 `ALLOW_DEV_LOGIN` 改成 `false`。两件都做才算干净。

### 方式 B：真实微信登录（拿到 AppSecret 后启用）

1. `server/.env` 填入 `WX_SECRET=你的AppSecret`
2. `miniprogram/src/utils/cloud.js` 改为 `const DEV_MODE = false`
3. 重新构建小程序

登录流程会自动变为：`wx.login` 取 code → 后端换 openid → 签发登录令牌。

---

## 五、账号与数据

### 默认管理员

| 账号 | 密码 | 说明 |
|---|---|---|
| `admin` | `admin123456` | 首次登录后请改密码 |

#### 「必须改初始密码」是怎么生效的（一整套闭环，改代码时别只改一半）

| 环节 | 位置 | 行为 |
|---|---|---|
| 数据库标记 | `users.must_change_password` | 管理员初始密码 / 新建用户的初始密码置 1 |
| 后端门禁 | `server/src/app.js` 中间件 | 标记为 1 时，除白名单动作外一律 403 |
| 白名单 | `PASSWORD_EXEMPT` | 只放行 `changePassword` / `getUserInfo` / `myLogs`（否则用户连改密页都打不开） |
| 前端路由守卫 | `admin/src/router/index.js` | 读 `localStorage.must_change_password`，非改密页一律跳 `/user/password` |
| 改密页 | `admin/src/views/user/password.vue` | 当前密码 + 新密码（≥6 位）+ 确认 |
| 顶栏提示 | `admin/src/views/Layout.vue` | 红标签「请先修改初始密码」，点进改密页 |

> ⚠️ 验收这个流程时，后端 `api-test.js` 收尾会**主动把标记还原成 1**，方便手动试；
> 如果你已经改过密码不想再试，用 `npm run db:reset-admin` 重置管理员即可。

### 角色说明（6 种）

| 角色 | 标识 | 能做什么 |
|---|---|---|
| 出库员 | `out` | 提交出库、查看自己的出库记录 |
| 入库员 | `in` | 提交入库、修改当天单价 |
| 采购员 | `purchase` | 采购入库、维护供应商 |
| 仓管 | `storekeeper` | 确认出入库单据、盘点、查库存 |
| 老板 | `boss` | 全部数据看板、审核、驳回 |
| 管理员 | `admin` | 用户与权限管理、系统设置 |

### 真实物料数据

已导入 **1909 条**物料（源表 1930 行，其中 20 组同名同规格重复已自动去重）：

| 仓库 | 数量 |
|---|---|
| 配件仓 | 1759 条 |
| 成品仓 | 150 条 |

---

## 六、常用命令

**推荐在项目根目录执行**（`G:/sl/shenglong-erp`），无需 `cd`：

```bash
npm run server            # 启动后端服务
npm run server:dev        # 启动后端（改代码自动重启）
npm run test:api          # 后端端到端回归测试（170 项）
npm run test:contract     # 前端契约验证（59 项，含数据安全自检）
npm run test:all          # 上面两个一起跑
npm run audit:data        # 上线前数据体检（只读，不改数据）
npm run verify            # 数据核对
npm run db:init           # 建表（幂等，可重复执行）
npm run db:seed           # 初始化仓库/配置/管理员
npm run seed:dev          # 建小程序开发身份（6 个角色，本地调试用）
npm run import:materials  # 导入物料（自动去重）
npm run dev:admin         # 启动 Web 后台
npm run dev:mp            # 启动小程序开发模式
npm run build:admin       # 打包 Web 后台
npm run build:mp          # 打包小程序
npm run mp:open           # 用微信开发者工具打开小程序（自动指向正确目录）
npm run mp                # 打包小程序 + 顺手打开开发者工具
```

> 等价写法：`cd server && npm start` 等，两种都能用。
> 所有脚本都会**自动定位 `server/.env`**，从哪个目录执行都能读到正确配置。

数据库相关（在项目根目录）：

```bash
docker compose ps                    # 查看状态
docker compose logs -f mysql         # 看数据库日志
docker compose exec mysql mysql -ushenglong -pshenglong123 shenglong   # 进数据库
docker compose down                  # 停止全部
```

---

## 七、测试

三套脚本，都打**真实运行的服务 + 真实数据库**（不是模拟），跑之前先 `npm run server`。

```bash
cd G:/sl/shenglong-erp
npm run test:api        # ① 后端端到端回归（170 项）
npm run test:contract   # ② 前端契约验证（59 项）
npm run test:all        # 上面两个连着跑（已串行，推荐）
npm run audit:data      # ③ 上线前数据体检（只读，不改数据）
```

### ① `test:api` — 后端端到端回归（170 项）

覆盖 24 个场景：认证、物料、入库、出库、库存一致性、幂等、驳回/撤销回补、盘点、
统计口径、权限隔离、并发安全，以及「4 角色真实使用者测试」暴露问题的**逐条整改回归**
（仓库级权限、数量正整数、改价三连修、盘点差异一致性、确认幂等、角色保护、文案与追责字段等）。

- 每个断言都核对数据库里的真实结果
- 开头**自动复位测试起点**（清残留单据、物料归零），所以可以反复跑
- 结束**自动清理**测试单据与流水

### ② `test:contract` — 前端契约验证（59 项）

验证「前端页面依赖的接口字段」是不是真的存在、格式对不对。分 10 节，逐页对照
小程序与 Web 后台用到的字段（如仓管确认前要看的 `current_stock`、对账页要的
`order_no` / `operator_name`、导出的 `transform` 回调、改密页、操作日志页等）。

**数据安全设计**（这套脚本做过专门加固，因为第一版曾经污染过真实数据）：

| 机制 | 说明 |
|---|---|
| 只用临时物料 | 全部以 `【契约验证】` 开头，不碰 1909 条真实料 |
| 基线 id 界定 | 脚本开头记录 `stock_logs` / 单据的最大 id，收尾按基线精确删除本轮新增 |
| 收尾自检 | 核对「本轮流水已清空」「真实物料库存未变」「真实物料条数未减少」三项 |

### ③ `audit:data` — 上线前数据体检（只读）

部署前跑一次，确认：测试单据/流水/盘点/供应商已清空、真实物料 1909 条且库存成本全 0、
不该存在的测试账号列表。**只 SELECT，不修改任何数据**，随时可跑。

```
  ✗ 上线前需删除   14 个（AUTOTEST_* 4、zhangshan/lina/zhaoliu/wangzong 4、dev_* 6）
```

> 这句 ✗ 是**预期内**的：这些账号本来就保留着方便手动验收，**部署时删掉即可**。
>
> 其中 `dev_*` 6 个是小程序开发身份。删掉账号之外，**还必须把 `ALLOW_DEV_LOGIN` 改成 false**，
> 否则等于留了个后门（两件都做才算干净）。

### ⚠️ 两套测试不能并行跑

`test:api` 和 `test:contract` 都会**删除「自己开始之后产生的所有数据」**。
同时跑的话，先跑完的那个会把另一个正在造的流水一起删掉，
表现为「流水累加 1 ≠ 当前库存 200」这种**看起来像代码 bug、其实不是**的失败。

已经加了**串行锁**（MySQL `GET_LOCK`，见 `server/tests/_test-lock.js`），并行时会直接拒绝并说明原因：

```
  前端契约验证 无法开始：另一个测试脚本正在占用数据库
  处理：等它跑完再跑，或直接用 npm run test:all（已串行）
```

用 `npm run test:all` 就不会碰到这个问题（内部是串行的）。

### 当前结果（2026-09-29）

| 脚本 | 结果 |
|---|---|
| `test:api` | **通过 170 项，失败 0 项** |
| `test:contract` | **通过 59 项，失败 0 项** |
| `audit:data` | 业务数据全 0，真实物料 1909 条零污染；14 个测试/开发账号待部署时删除 |

---

## 八、常见问题

### 1. Docker 拉不到镜像（国内网络）

现象：`docker compose up -d mysql` 报 `failed to resolve reference "docker.io/library/mysql:8.0"`

解决：用国内镜像源拉取后重新打标签：

```bash
docker pull docker.1panel.live/library/mysql:8.0
docker tag docker.1panel.live/library/mysql:8.0 mysql:8.0
docker compose up -d mysql
```

也可以永久配置镜像加速：修改 `~/.docker/daemon.json` 加 `"registry-mirrors"`，然后重启 Docker Desktop。

### 2. 后端启动报「数据库连接失败」

- 确认 MySQL 容器是 `healthy`：`docker compose ps`
- 确认 `server/.env` 里 `DB_PORT=3307`（这是映射到本机的端口，不是 3306）
- 本地如果装过 MySQL 占用 3306，我们用的是 **3307**，两者不冲突

### 3. 小程序请求失败

- 开发者工具里勾上「**不校验合法域名**」（见第三节）
- 确认后端服务在跑：`curl http://localhost:3000/api/health`
- 真机测试要用局域网 IP，不能用 localhost

### 3.1 模拟器启动失败：在项目根目录未找到 app.json

**原因**：开发者工具导入的目录选成了 `miniprogram/`（源码根目录）。
uni-app 的源码根目录里**没有 `app.json`**，只有 `src/pages.json`；
`app.json` 是编译产物，在 `dist/build/mp-weixin/` 里。

**三种修法，任选一种**：

1. 开发者工具 → 项目 → 导入项目 → 目录改成：
   `G:/sl/shenglong-erp/miniprogram/dist/build/mp-weixin`
2. 执行 `npm run mp:open`（自动打开正确目录；需先在
   工具 → 设置 → 安全设置 里开启「服务端口」）
3. 什么都不改：`miniprogram/project.config.json` 里已经配了
   `"miniprogramRoot": "dist/build/mp-weixin/"`，
   在工具里对当前项目点一次「**编译**」即可

> 起来了却看不到功能？那是另一个问题，见下一条。

### 3.2 模拟器起来了，但登录后什么都没看到

开发模式下小程序用 `dev_openid` 登录。后端遇到没见过的 openid 会自动建档，
但**角色为空、状态是 `pending`**，所以首页一个入口都不显示。

修法：跑一次 `npm run seed:dev`（建好 6 个带角色的开发身份），
然后在「我的」页面用「开发身份」切到想要的角色。详见第四节「方式 A」。

### 4. 登录后提示「账号正在审核中」

新用户默认是 `pending` 状态，需要管理员在后台「用户管理」里审核并分配角色。

### 5. 端口被占用

| 端口 | 用途 | 冲突时怎么办 |
|---|---|---|
| 3307 | MySQL | 改 `.env` 与 `docker-compose.yml` 的映射端口 |
| 3000 | 后端接口 | 改 `server/.env` 的 `PORT`，同时改小程序 `cloud.js` 的 `API_BASE` |
| 5173 | Web 后台 | Vite 会自动换端口 |

### 6. 改了后端代码不生效

先分清是**服务没真重启**还是**代码没生效**——这两种现象一样，处理完全不同。

**日常推荐**（改代码自动重启）：

```bash
npm run server:dev     # 用 node --watch
```

**如果服务是后台跑着的、Ctrl+C 够不着**（Windows 上踩过坑，务必按顺序做）：

```bash
# 1) 先查是谁占着 3000
netstat -ano | grep LISTENING | grep ":3000"

# 2) 杀它（// 是 Git Bash 下的转义，PID 换成上一步查到的）
taskkill //PID <PID> //F

# 3) 确认端口真的空了，再启动（这一步不能省）
netstat -ano | grep LISTENING | grep ":3000" || echo "port 3000 is FREE"
```

> ⚠️ **为什么必须确认端口**：套一层 shell 去杀进程时，命令有可能**返回成功但进程没死**
> （静默失败）。此时旧进程继续在 3000 上服务**旧代码**，你怎么刷新都看不到改动，
> 会误以为是浏览器缓存问题。**端口查空**是唯一可靠的判断依据。

**确认服务端到底返回了什么**（用真实 HTTP 查，别用进程内单测）：

```bash
curl -s http://127.0.0.1:3000/api/health
curl -s -X POST http://127.0.0.1:3000/api/material \
  -H "Content-Type: application/json" \
  -d '{"action":"list","data":{"page":1,"pageSize":1},"token":"<你的token>"}'
```

### 6.1 看到 `npm run server` 报 Failed 但服务还活着

那多半是**你自己刚把旧进程杀了**，后台任务随之退出——正常。重新 `npm run server` 即可。

### 7. 报错 `connect ECONNREFUSED 127.0.0.1:3306`

如果你看到连的是 **3306**，说明**配置文件没被读到**（本项目用的是 **3307**）。

- 原因：`dotenv` 默认按「当前工作目录」找 `.env`，从项目根执行时会找不到 `server/.env`，静默退回默认端口。
- 现状：**已修复**。`server/src/config/env.js` 统一以文件自身位置为锚点定位 `server/.env`，
  所有入口（服务、建表、导入、核对、测试）都改为引用它，从任何目录执行结果一致。
- 若仍出现，检查 `server/.env` 是否真的存在（不是只有 `.env.example`）：
  `server/.env` 里应有 `DB_PORT=3307`。

---

## 九、目录速查

```
G:/sl/shenglong-erp/
├── server/             后端服务（Node + Express + MySQL）
│   ├── src/config/     env.js 统一读取 server/.env（与启动目录无关）
│   ├── src/modules/    10 个业务模块
│   ├── src/services/   stock.js（库存唯一出口）、wechat.js、orderNo.js
│   ├── src/db/         schema.sql 建表、init/seed/seed-dev/import/verify 脚本
│   └── tests/          api-test.js 端到端回归、verify-frontend-contracts.js 前端契约验证、
│                       data-audit.js 上线前体检、_test-lock.js 串行锁
├── miniprogram/        小程序（uni-app Vue3）
│   ├── src/utils/      cloud.js 接口封装、api.js 业务接口
│   ├── scripts/        open-devtools.js 一键用开发者工具打开正确目录
│   └── dist/build/mp-weixin/   ★ 编译产物 —— 开发者工具要打开的就是这一层
├── admin/              Web 后台（Vue3 + Element Plus）
├── docker-compose.yml  一键起 MySQL + 接口 + 自动备份
├── .env                整套跑 Docker 时的配置（服务器部署用这个）
└── docs/               文档
```

---

## 十、两种跑法（别混用配置）

本系统有两种运行方式，**读的是不同的配置文件**，搞清楚这一点能省掉大量困惑：

| | 方式一：数据库在 Docker，后端直接跑 | 方式二：整套都在 Docker |
|---|---|---|
| 适用 | **本机开发调试**（推荐） | 服务器部署、整机验证 |
| 启动 | `docker compose up -d mysql` + `npm run server` | `docker compose up -d` |
| 配置文件 | `server/.env` | 根目录 `.env` |
| 数据库地址 | `127.0.0.1:3307` | 容器内 `mysql:3306` |
| 改代码 | 重启即可，无需重建镜像 | 要重新 build 镜像 |

> **服务器部署用「方式二」**，配置写到根目录 `.env`（从 `.env.example` 复制）。
> `server/.env` 里的内容**不会**进入 Docker 容器——容器配置全部由 `docker-compose.yml`
> 从根目录 `.env` 注入。这是刻意设计的：密钥不进镜像，改配置不用重新打包。

### 首次准备方式二的配置

```bash
cd G:/sl/shenglong-erp
cp .env.example .env
# 生成一个真正的签名密钥，替换掉 .env 里的 JWT_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## 十一、从零到可跑（方式一 · 完整顺序）

如果换一台电脑，或需要重建环境，按这个顺序执行：

```bash
cd G:/sl/shenglong-erp

# 1. 起数据库（只建空库，表由下一步创建）
docker compose up -d mysql
docker compose ps                 # 等到显示 healthy

# 2. 装依赖
cd server && npm install && cd ..
cd admin && npm install && cd ..
cd miniprogram && npm install && cd ..

# 3. 准备配置
cp server/.env.example server/.env    # 然后按需改密码等
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"  # 生成密钥填进 JWT_SECRET

# 4. 初始化数据
npm run db:init           # 建表
npm run db:seed           # 仓库、配置、管理员账号
npm run import:materials  # 导入 1909 条物料
npm run verify            # 核对，应显示「全部检查通过，数据就绪」

# 5. 起服务并自测
npm run server            # 另开一个终端
npm run test:api          # 应显示「通过 80 项，失败 0 项」
```

---

## 十二、整套跑 Docker（方式二）

```bash
cd G:/sl/shenglong-erp
cp .env.example .env            # 首次
# 改 .env：JWT_SECRET 换成随机串，DB_ROOT_PASSWORD/DB_PASSWORD 换成强密码

docker compose up -d --build
docker compose ps               # mysql / api / backup 三个都应为 Up

# 首次要手动初始化数据（容器不会自动建表）
docker compose exec api node src/db/init.js
docker compose exec api node src/db/seed.js
docker compose exec api node src/db/import-materials.js
docker compose exec api node src/db/verify.js

# 自测
curl http://localhost:3000/api/health
docker compose exec api node tests/api-test.js   # 若 tests 未打进镜像，改为宿主机 npm run test:api
```

> 镜像里**不含** `.env`（见 `server/.dockerignore`），所有配置由 compose 注入。
> 这样密钥不会被烧进镜像层，换服务器只改根目录 `.env` 即可。
