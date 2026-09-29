# 胜龙进销存 · 服务器部署指南（Docker）

> **版本**：v2.0（Docker 自建后端版） | **更新日期**：2026-09-29
> **前提**：本地已按 [BACKEND-PLAN.md](./BACKEND-PLAN.md) 完成开发并验证通过
> **原则**：本地验证通过 → 整体搬到服务器，**不做线上试错**

---

## 前置条件

| 项 | 要求 | 备注 |
|---|---|---|
| 服务器 | Linux，**建议 2核4G 起**，Ubuntu 22.04+ / CentOS 7+ | 需能 SSH 登录 |
| 域名 | **已完成 ICP 备案** | 小程序硬性要求，无法绕过 |
| DNS | 域名 A 记录指向服务器 IP | 在域名服务商处添加 |
| 小程序 | 已拿到 **AppSecret** | 微信公众平台 → 开发管理 → 开发设置 |
| 本地 | 项目已开发完毕且验证通过 | |

> ⚠️ **备案是最大时间变量**，通常需 2-3 周。若尚未备案，**建议立刻启动**，开发可以先在本地跑。

---

## 第一步：服务器环境准备

```bash
# 1. 更新系统
apt update && apt upgrade -y        # CentOS 用 yum

# 2. 安装 Docker 与 Compose
curl -fsSL https://get.docker.com | sh
systemctl enable docker && systemctl start docker

# 3. 验证
docker --version && docker compose version
```

**安全基线（务必执行）**：

```bash
# 关闭密码登录，仅允许密钥
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart sshd

# 防火墙：只开放 22 / 80 / 443
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw enable

# MySQL 端口(3306) 与接口端口(3000) 不要对外开放，仅容器内网访问
```

---

## 第二步：上传项目

**只需上传运行所需的最小集合**（小程序与后台源码不必上服务器）：

```
server/               # 后端服务
docker-compose.yml
.env                  # 服务器专用配置
nginx/shenglong.conf  # Nginx 站点配置
```

上传方式（任选）：

```bash
# 方式一：scp
scp -r server docker-compose.yml root@服务器IP:/opt/shenglong/

# 方式二：git（推荐，便于后续更新）
git clone <你的仓库地址> /opt/shenglong
```

目录规划建议：

```
/opt/shenglong/          # 应用目录
/opt/shenglong/data/mysql     # 数据库数据（挂载卷，务必持久化）
/opt/shenglong/data/uploads   # 上传的文件与图片
/opt/shenglong/data/backup    # 每日自动备份
```

---

## 第三步：配置环境变量

服务器上用 **`docker compose`** 的方式运行，读的是**项目根目录的 `.env`**：

```bash
cd /opt/shenglong
cp .env.example .env
```

然后按下面填。**变量名必须与 `docker-compose.yml` 里的一致**，否则不生效：

```ini
# ---- 运行环境 ----
NODE_ENV=production

# ---- 数据库 ----
DB_NAME=shenglong
DB_USER=shenglong
DB_PASSWORD=改成一个高强度密码
DB_ROOT_PASSWORD=另一个高强度密码（数据库 root 用）

# ---- 身份认证（关键）----
# 生成方法：node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
JWT_SECRET=替换成一串随机长字符串
JWT_EXPIRES_IN=7d

# ---- 微信小程序 ----
WX_APPID=你的AppID
WX_SECRET=你的AppSecret

# ---- 开发者登录开关（关键）----
# 必须为 false：为 true 时可用任意 openid 跳过微信登录
ALLOW_DEV_LOGIN=false

# ---- 初始管理员（首次 db:seed 时创建）----
ADMIN_USERNAME=admin
ADMIN_PASSWORD=改成一个强密码

# ---- 基础镜像源（国内服务器必填）----
# 服务器直连 Docker Hub 通常失败，用国内镜像源
NODE_BASE_IMAGE=docker.1panel.live/library/node:20-alpine
```

> ### ⚠️ 两个 `.env` 的区别（最容易搞混的地方）
>
> | 文件 | 谁读它 | 数据库地址 |
> |---|---|---|
> | `server/.env` | 后端在**宿主机直接跑**时（`npm start`） | `127.0.0.1:3307` |
> | **根目录 `.env`** | **`docker compose`（服务器就是这个）** | 容器内 `mysql:3306` |
>
> 服务器部署**只需要根目录 `.env`**。`server/.env` 里的内容**不会**进入容器——
> 这是刻意的：密钥不进镜像，改配置不用重新打包。
>
> **`server/.dockerignore` 已排除 `.env`**，确认它存在且内容正确，
> 否则密钥会被烧进镜像层（可用第四步的检查命令验证）。

> **安全提醒**：`.env` 含数据库密码和 AppSecret，**不要提交到 Git**，`.gitignore` 中必须排除。

---

## 第四步：启动服务

```bash
cd /opt/shenglong
docker compose up -d --build

# 查看状态（mysql / api / backup 三个都应为 Up，mysql 为 healthy）
docker compose ps
docker compose logs -f api

# 健康检查
curl http://localhost:3000/api/health
```

**启动后立刻做这两项安全检查**（都是几十秒的事，能挡掉两类严重事故）：

```bash
# 检查一：镜像里不能有 .env（有则说明 .dockerignore 失效，密钥已进镜像）
docker compose exec api ls -a /app | grep -x ".env" \
  && echo "❌ 危险：密钥已烧进镜像，请检查 server/.dockerignore" \
  || echo "✓ 镜像内无 .env"

# 检查二：确认开发者登录已关闭（为 true 时任何人可用任意 openid 登录）
docker compose exec api printenv ALLOW_DEV_LOGIN
# 预期输出：false
```

> 关键配置是否真的生效，也可以用同样方式确认：
> `docker compose exec api printenv JWT_SECRET` 应输出你自己设的那串，
> **不应是** `change-me-to-a-long-random-string`。

---

## 第五步：初始化数据库

```bash
# 建表 + 索引（13 张表）
docker compose exec api node src/db/init.js

# 初始化基础数据（两个仓库、系统配置、初始管理员）
docker compose exec api node src/db/seed.js

# 导入真实物料数据（源表 1930 行，自动去重后 1909 条）
docker compose exec api node src/db/import-materials.js

# 自动核对（会检查表结构、索引、数据条数）
docker compose exec api node src/db/verify.js
```

> 容器不会自动建表，这一步必须手动执行一次。

**导入后核对**：

```bash
docker compose exec mysql mysql -ushenglong -p shenglong -e "
  SELECT w.name AS 仓库, COUNT(*) AS 物料数, SUM(m.current_stock) AS 总库存
  FROM materials m JOIN warehouses w ON w.id = m.warehouse_id
  WHERE m.is_deleted = 0 GROUP BY w.id;"
```

预期：成品仓 **150** 条、配件仓 **1759** 条，合计 **1909** 条。

> 为什么不是 1930？源表里有 20 组「同名同规格」重复（共 21 行），
> 导入脚本按名称+规格自动去重，1930 − 21 = 1909。这是预期结果，不是数据丢失。

**部署后跑一遍端到端测试**（这是最强的验证手段，容器内直接跑）：

```bash
docker compose exec api node tests/api-test.js
# 预期最后一行：测试完成：通过 80 项，失败 0 项
```

测试会真连数据库、真发 HTTP 请求，覆盖库存一致性、重复提交不重复扣减、
5 笔并发出库不超扣等场景，结束时自动清理测试数据。

---

## 第六步：配置 Nginx 与 HTTPS

**站点配置** `/etc/nginx/sites-available/shenglong`：

```nginx
server {
    listen 80;
    server_name 你的域名;

    # 接口转发
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 20m;
    }

    # 上传文件
    location /uploads/ {
        alias /opt/shenglong/data/uploads/;
    }

    # Web 后台静态文件（若部署在同一台）
    location / {
        root /opt/shenglong/admin-dist;
        try_files $uri $uri/ /index.html;
    }
}
```

启用并申请证书：

```bash
ln -s /etc/nginx/sites-available/shenglong /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# 免费 HTTPS 证书（自动续期）
apt install -y certbot python3-certbot-nginx
certbot --nginx -d 你的域名
```

验证：

```bash
curl -I https://你的域名/api/health     # 应返回 200
```

---

## 第七步：配置微信小程序后台

1. 登录 **微信公众平台** → 开发管理 → 开发设置 → **服务器域名**
2. 在 **request 合法域名** 中添加：`https://你的域名`
3. 在 **uploadFile 合法域名** 中添加：`https://你的域名`（如用到文件上传）
4. 保存后**等待生效**（通常几分钟）

> 注意：必须是 **HTTPS**，且域名**已备案**，且**不能带端口号或路径**。

---

## 第八步：上线验证

| # | 验证项 | 预期结果 |
|---|---|---|
| 1 | `https://你的域名/api/health` | 返回正常 |
| 2 | 小程序真机打开 | 能调起微信登录 |
| 3 | 新用户首次进入 | 提示待审核 |
| 4 | 管理员审核通过 | 用户可正常使用对应角色功能 |
| 5 | 提交一笔出库 | 库存减少，流水有记录 |
| 6 | 重复提交同一单据 | 只生效一次（幂等） |
| 7 | Web 后台登录 | 能进入并看到真实数据 |
| 8 | 手机与电脑同时操作 | 数据一致，库存不串 |

---

## 第九步：自动备份

在 `docker-compose.yml` 中已内置备份服务，每日执行 `mysqldump` 到 `/opt/shenglong/data/backup/`，保留 30 天。

**额外建议**：每周手动拉一份到本地或对象存储：

```bash
scp root@服务器IP:/opt/shenglong/data/backup/最新文件.sql ./
```

---

## 日常运维命令

```bash
docker compose ps                     # 查看服务状态
docker compose logs -f api            # 看接口日志
docker compose restart api            # 重启接口
docker compose up -d --build          # 更新代码后重新构建
docker compose down                   # 停止全部
docker compose exec mysql mysql -u... # 进数据库
```

---

## 常见问题

### 0. 构建镜像失败：连不上 Docker Hub

现象（`docker compose up -d --build` 时）：

```
ERROR: failed to solve: node:20-alpine: failed to resolve source metadata for
docker.io/library/node:20-alpine ... connection attempt failed
```

原因：国内服务器直连 Docker Hub 基本不通。

**解决**（已在配置里预留开关，改 `.env` 一行即可）：

```ini
NODE_BASE_IMAGE=docker.1panel.live/library/node:20-alpine
```

然后重新构建：`docker compose up -d --build`

也可以在服务器上永久配置镜像加速：修改 `/etc/docker/daemon.json` 加
`"registry-mirrors"`，重启 Docker 后就不用再改 `NODE_BASE_IMAGE`。

> 同样的坑在拉 `mysql:8.0` 时也会遇到，处理方式见
> [LOCAL-DEV.md 第八节](./LOCAL-DEV.md)。

### 1. 小程序请求失败 / 域名不合法

- 检查域名是否**已备案**
- 检查 HTTPS 证书是否有效（`curl -I` 验证）
- 检查微信后台的**服务器域名**是否已填写并生效
- 开发阶段可在开发者工具中勾选「**不校验合法域名**」临时绕过（正式上线不可用）

### 2. 小程序登录失败

- 检查 `WX_APPID` / `WX_SECRET` 是否正确
- 检查服务器能否访问微信接口（`curl https://api.weixin.qq.com`）
- 查看日志：`docker compose logs api | grep code2session`

### 3. 库存数据对不上

- **不要直接改数据库**，应通过系统做「调整单」
- 用盘点功能核对：创建盘点任务 → 录入实际库存 → 审核差异 → 自动回写
- 所有变动都能在 `stock_logs` 表中追溯到（含变动前后值）

### 4. 数据库连接失败

```bash
docker compose logs mysql             # 看数据库日志
docker compose exec api ping mysql    # 容器内测连通
```

### 5. 内存不足

- 在 `docker-compose.yml` 中为 mysql 设置 `command: --innodb-buffer-pool-size=256M`
- 或升级服务器配置

---

## 部署完成检查清单

**环境与安全**

- [ ] Docker 与 Compose 已安装并开机自启
- [ ] 服务器防火墙仅开放 22 / 80 / 443（3306 / 3000 不对外）
- [ ] 根目录 `.env` 已配置，且**未被提交到 Git**
- [ ] `JWT_SECRET` 已替换为随机长字符串（不是 `change-me-to-a-long-random-string`）
- [ ] `ALLOW_DEV_LOGIN=false`（已用 `printenv` 确认）
- [ ] 镜像内**不含** `.env`（已用 `ls -a /app` 确认）
- [ ] 数据库密码已改掉默认值

**服务与数据**

- [ ] `docker compose ps` 三个服务（mysql / api / backup）均为 Up
- [ ] 13 张表创建完成
- [ ] 真实物料 **1909** 条导入并核对无误
- [ ] 两个仓库（配件仓 1759 / 成品仓 150）数量正确
- [ ] 初始管理员账号可登录
- [ ] 容器内端到端测试通过：**80 项通过，0 项失败**
- [ ] 自动备份任务已运行并产生备份文件

**对外访问**

- [ ] Nginx 反代正常，HTTPS 证书有效且自动续期
- [ ] 微信后台服务器域名已配置
- [ ] 小程序真机全流程走通（登录 → 审核 → 出库 → 库存变化）
- [ ] 幂等验证通过（重复提交不重复出库）
