# 胜龙进销存系统

> 微信小程序 + Web 后台管理的进销存系统，数据放在自家服务器上

## 技术栈

| 部分 | 技术 |
|---|---|
| 小程序端 | uni-app（Vue3 + Pinia），编译成微信小程序 |
| Web 后台 | Vue3 + Element Plus + Vite |
| 后端 | Node.js + Express + MySQL（**自建服务器，不再用微信云开发**） |
| 数据库 | MySQL 8（本地用 Docker 起） |
| 登录 | 微信登录（code2session）+ 账号密码；本地开发可用「开发身份」直接登 |

## 项目结构

```
shenglong-erp/
├── server/         后端服务（Node + Express + MySQL）
│   ├── src/modules/    业务模块
│   ├── src/db/         建表 / 种子数据 / 导入物料
│   └── tests/          回归测试、契约验证、上线前体检
├── miniprogram/    小程序（uni-app Vue3）
│   ├── src/            源码
│   └── dist/build/mp-weixin/   ★ 编译产物 —— 微信开发者工具要打开的是这一层
├── admin/          Web 后台（Vue3 + Element Plus）
├── deploy/         服务器部署（Docker）
└── docs/           文档
```

## 快速开始

完整步骤（含环境准备和踩坑说明）见 **[docs/LOCAL-DEV.md](docs/LOCAL-DEV.md)**。
最短路径：

```bash
npm run db:up        # 起 MySQL（Docker，映射到 3307）
npm run db:init      # 建表
npm run db:seed      # 初始化仓库、系统配置、管理员
npm run seed:dev     # 建小程序开发身份（6 个角色，本地调试用）
npm run server       # 起后端 → http://localhost:3000
npm run import:materials   # 导入真实物料（放在 server/data 里）
```

Web 后台：

```bash
npm run dev:admin    # http://localhost:5173，用 admin / admin123456 登录
```

小程序：

```bash
npm run mp           # 打包，并用微信开发者工具打开正确目录
```

> ⚠️ **微信开发者工具要打开 `miniprogram/dist/build/mp-weixin`，不是 `miniprogram/`。**
> uni-app 的源码根目录里没有 `app.json`（只有 `src/pages.json`），
> 选错会报「**Error: app.json 在项目根目录未找到 app.json**」，模拟器起不来。
> 详见 [docs/LOCAL-DEV.md](docs/LOCAL-DEV.md) 第四节与常见问题 3.1。

实测可用环境：node 20+、Docker Desktop、微信开发者工具 3.17.x。

## 测试

三套脚本都打**真实运行的服务 + 真实数据库**（不是 mock）：

```bash
npm run test:all     # 后端回归 170 项 + 前端契约验证 59 项（内部串行）
npm run audit:data   # 上线前数据体检（只读，不改数据）
```

> `test:api` 与 `test:contract` **不能并行跑**——两者都会清理「自己开始之后的数据」，
> 并行会互相误删。用 `npm run test:all`，或依赖脚本内置的串行锁。

## 文档

- [本地运行手册](docs/LOCAL-DEV.md) —— 环境准备、启动、常见问题排查
- [4 角色使用者测试报告 + 整改记录](docs/4-ROLE-USER-TEST-REPORT.md)
- [后端方案](docs/BACKEND-PLAN.md) / [部署指南](docs/DEPLOY-GUIDE.md)
- [开发日志](docs/daily-log.md)

## 许可证

内部项目，仅供胜龙汽配使用
