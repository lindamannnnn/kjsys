# 胜龙进销存系统 · 开发文档

> **项目**：胜龙进销存系统（微信小程序 + Web 后台）
> **版本**：v3.0 | **启动日期**：2026-09-28 | **架构变更**：2026-09-29
> **技术栈**：uni-app（Vue3）+ **自建后端（Node.js + Express + MySQL 8）** + Vue3 + Element Plus
> **交付形态**：本地 Docker 一键起 → 验证通过 → 整体部署到服务器

> ⚠️ **架构变更说明（2026-09-29）**
> 因个人主体小程序未认证、无法开通微信云开发，后端架构已从「微信云开发（云函数 + 云数据库）」
> 改为「**自建服务器（Node 接口服务 + MySQL，Docker 化交付）**」。
> 详细方案见 **[BACKEND-PLAN.md](./BACKEND-PLAN.md)**。
>
> **本文档中所有"云函数""云数据库集合""云存储"的字样，均按如下对应关系理解：**
>
> | 本文档旧称 | 现实际实现 |
> |---|---|
> | 云函数（如 outbound） | 后端模块 `/api/outbound`（Express 路由） |
> | 云数据库集合 | MySQL 表（见 BACKEND-PLAN 第五章） |
> | `cloud.getWXContext().OPENID` | `code2session` + JWT 令牌 |
> | 云存储 | 服务器本地目录 + Nginx |
> | 云函数定时触发器 | node-cron 定时任务 |
>
> **接口契约保持不变**：仍为 `{ module, action, data, client_request_id }` → `{ code, data, message }`，
> 因此前端业务页面无需改动。

---

## 一、项目结构

```
shenglong-erp/
├── miniprogram/                 # 微信小程序（uni-app）
│   ├── pages/                   # 页面
│   │   ├── index/               # 首页（角色识别）
│   │   ├── login/               # 登录
│   │   ├── out/                 # 出库模块
│   │   │   ├── submit/          # 出库提交
│   │   │   ├── history/         # 出库历史
│   │   │   └── detail/          # 出库详情
│   │   ├── in/                  # 入库模块
│   │   │   ├── submit/          # 入库提交
│   │   │   ├── history/         # 入库历史
│   │   │   └── detail/          # 入库详情
│   │   ├── check/               # 盘点模块
│   │   │   ├── list/            # 盘点任务
│   │   │   ├── submit/          # 盘点录入
│   │   │   └── detail/          # 盘点详情
│   │   ├── boss/                # 老板看板
│   │   │   ├── dashboard/       # 总览
│   │   │   ├── trend/           # 趋势
│   │   │   ├── stock/           # 库存台账
│   │   │   ├── orders/          # 单据流水
│   │   │   └── warning/         # 库存预警
│   │   └── my/                  # 我的
│   │       └── profile/         # 个人信息
│   ├── components/              # 公共组件
│   ├── store/                   # 状态管理（Pinia）
│   ├── utils/                   # 工具函数
│   ├── static/                  # 静态资源
│   ├── App.vue
│   ├── main.js
│   ├── manifest.json
│   ├── pages.json
│   └── uni.scss
├── admin/                       # Web 后台管理（Vue3 + Element Plus）
│   ├── src/
│   │   ├── views/               # 页面
│   │   │   ├── dashboard/       # 数据看板
│   │   │   ├── stats/           # 数据统计
│   │   │   ├── user/            # 用户管理
│   │   │   ├── role/            # 权限管理
│   │   │   ├── material/        # 物料管理
│   │   │   ├── order/           # 单据管理
│   │   │   ├── check/           # 盘点管理
│   │   │   └── setting/         # 系统设置
│   │   ├── components/          # 公共组件
│   │   ├── router/              # 路由
│   │   ├── store/               # 状态管理
│   │   ├── utils/               # 工具函数
│   │   └── api/                 # API 封装
│   ├── public/
│   ├── index.html
│   └── vite.config.js
├── cloudfunctions/              # 云函数
│   ├── auth/                    # 登录/角色
│   ├── material/                # 物料 CRUD
│   ├── outbound/                # 出库单
│   ├── inbound/                 # 入库单
│   ├── check/                   # 盘点
│   ├── stats/                   # 统计
│   ├── export/                  # 导出
│   ├── notify/                  # 预警推送
│   ├── backup/                  # 每日备份
│   ├── approve/                 # 审批流
│   └── user/                    # 用户管理
├── docs/                        # 文档
│   ├── api/                     # API 文档
│   ├── db/                      # 数据库设计
│   └── deploy/                  # 部署文档
├── scripts/                     # 脚本
│   ├── init/                    # 初始化脚本
│   ├── backup/                  # 备份脚本
│   └── migrate/                 # 数据迁移
├── tests/                       # 测试
│   ├── unit/                    # 单元测试
│   └── e2e/                     # 端到端测试
├── .workbuddy/                  # WorkBuddy 项目配置
│   └── memory/                  # 项目记忆
├── README.md                    # 项目说明
└── package.json                 # 根 package.json（工作区）
```

---

## 二、数据库设计（9 个集合）

### 2.1 users（用户与角色）

```javascript
{
  _id: String,
  _openid: String,           // 微信 openid
  nickname: String,          // 微信昵称
  avatar: String,            // 微信头像
  real_name: String,         // 真实姓名
  phone: String,             // 手机号
  roles: ['out','in','boss','admin'],  // 角色数组
  warehouse_ids: [],         // 数据级权限：所属仓库
  status: 'active'/'disabled'/'pending',
  created_at: Date,
  last_login_at: Date
}
```

### 2.2 materials（物料档案）

```javascript
{
  _id: String,
  name: String,              // 物料名称
  category: String,          // 分类
  unit: String,              // 单位
  spec: String,              // 规格
  barcode: String,           // 条码（预留）
  current_stock: Number,     // 当前库存
  warning_stock: Number,     // 预警库存
  avg_cost: Number,          // 移动加权平均成本
  image_fileid: String,      // 物料图片
  is_deleted: Boolean,
  created_at: Date,
  updated_at: Date
}
```

### 2.3 outbound_orders（出库单）

```javascript
{
  _id: String,
  order_no: String,          // OUT-20260928-001
  type: String,              // 领用/销售/报废/赠品/调整/采购退货
  material_id: String,
  material_name: String,     // 冗余
  material_spec: String,     // 冗余
  quantity: Number,
  unit: String,
  operator_openid: String,
  operator_name: String,
  purpose: String,           // 用途/去向
  remark: String,
  status: 'pending'/'approved'/'rejected'/'completed',
  approver_openid: String,
  approver_name: String,
  approved_at: Date,
  is_deleted: Boolean,
  created_at: Date
}
```

### 2.4 inbound_orders（入库单）

```javascript
{
  _id: String,
  order_no: String,          // IN-20260928-001
  type: String,              // 采购入库/销售退货/调整
  material_id: String,
  material_name: String,
  material_spec: String,
  quantity: Number,
  unit: String,
  unit_price: Number,
  total_price: Number,
  supplier: String,
  supplier_id: String,
  operator_openid: String,
  operator_name: String,
  remark: String,
  is_deleted: Boolean,
  created_at: Date
}
```

### 2.5 stock_checks（盘点单）

```javascript
{
  _id: String,
  check_no: String,          // CHK-20260928-001
  type: String,              // 全盘/抽盘/循环
  status: 'pending'/'in_progress'/'pending_review'/'completed',
  freeze_stock: Boolean,     // 盘点时锁定库存
  assignee_openids: [],      // 盘点人员
  scope: {
    categories: [],
    material_ids: []
  },
  items: [{
    material_id: String,
    material_name: String,
    book_stock: Number,      // 账面库存
    actual_stock: Number,    // 实际库存
    difference: Number       // 差异
  }],
  operator_openid: String,
  operator_name: String,
  reviewer_openid: String,
  reviewer_name: String,
  reviewed_at: Date,
  created_at: Date,
  completed_at: Date
}
```

### 2.6 stock_logs（库存流水，P0 新增）

```javascript
{
  _id: String,
  material_id: String,
  material_name: String,
  change_type: String,       // outbound/inbound/check/adjust/transfer
  change_quantity: Number,   // 正数=增加，负数=减少
  before_stock: Number,      // 变动前库存
  after_stock: Number,       // 变动后库存
  related_order_id: String,  // 关联单据
  related_order_type: String,
  operator_openid: String,
  operator_name: String,
  created_at: Date
}
```

### 2.7 suppliers（供应商）

```javascript
{
  _id: String,
  name: String,
  contact: String,
  phone: String,
  address: String,
  remark: String,
  is_deleted: Boolean,
  created_at: Date
}
```

### 2.8 operation_logs（操作日志）

```javascript
{
  _id: String,
  openid: String,
  role: String,
  action: String,            // login/outbound_submit/inbound_submit/...
  target_type: String,       // order/material/user
  target_id: String,
  detail: Object,
  result: String,            // success/fail
  fail_reason: String,
  created_at: Date
}
```

### 2.9 settings（系统配置）

```javascript
{
  _id: 'global',
  company_name: String,
  warning_enabled: Boolean,
  warning_notify_boss: Boolean,
  backup_enabled: Boolean,
  boss_openids: [],
  order_no_prefix_out: String,
  order_no_prefix_in: String
}
```

---

## 三、后端模块设计（7 个业务模块 + 3 个支撑模块）

> 原「云函数」现由后端 Express 路由承载，调用形态不变，仅传输方式由 `wx.cloud.callFunction` 改为 `wx.request`。

| 模块 | 职责 | 关键逻辑 |
|--------|------|---------|
| auth | 登录/注册/角色 | 小程序：code → code2session → openid；后台：账号密码。签发 JWT，返回 roles + warehouse_ids |
| material | 物料 CRUD | 列表/详情/新增/编辑/删除/批量导入 |
| outbound | 出库单 | 提交（事务）/撤销/审批/我的历史 |
| inbound | 入库单 | 提交（事务）/改价/我的历史 |
| check | 盘点 | 创建任务/提交结果/审核差异/历史查询 |
| stats | 统计 | 总览/趋势/台账/流水/预警/库存流水 |
| export | 导出 | CSV 生成 → 云存储 → 返回链接 |
| notify | 预警推送 | 定时扫描库存 → 微信订阅消息推送 |
| backup | 每日备份 | 导出当日数据 → 云存储归档 |
| approve | 审批流 | 提交审批/审批通过/审批拒绝 |
| user | 用户管理 | 列表/审核/禁用/启用（后台专用） |

---

## 四、接口设计（22 个）

### 4.1 统一调用方式

**统一接口形态（自建后端）**：`POST /api/{module}`，请求体 `{ action, data, client_request_id }`，响应 `{ code, data, message }`。

```javascript
// 小程序端（utils/cloud.js 内部实现，业务页面无需改动）
wx.request({
  url: `${API_BASE}/api/outbound`,
  method: 'POST',
  header: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`     // JWT 令牌
  },
  data: {
    action: 'submit',
    data: { material_id, quantity, type, remark, warehouse_id },
    client_request_id: 'uuid-' + Date.now()  // 幂等键
  }
})

// Web 后台端（admin/src/api/index.js，仅需改 API_BASE）
fetch(`${API_BASE}/api/outbound`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    action: 'submit',
    data: { material_id, quantity, type, remark, warehouse_id },
    client_request_id: 'uuid-' + Date.now()
  })
})
```

> **约定**：`client_request_id` 在后端建唯一索引，同一 ID 重复提交会被数据库直接拦截并返回首次结果，保证不会重复出库/入库。

### 4.2 接口清单

| 模块 | 接口 | 说明 | 权限 |
|------|------|------|------|
| auth | login | 微信登录 | 所有 |
| auth | register | 首次注册（待审核） | 所有 |
| auth | updateProfile | 更新资料 | 所有 |
| material | list | 物料列表（分页） | 所有登录用户 |
| material | detail | 物料详情 | 所有登录用户 |
| material | upsert | 新增/编辑 | boss/admin |
| material | import | 批量导入 | boss/admin |
| outbound | submit | 提交出库（事务） | out |
| outbound | cancel | 撤销出库 | out（本人） |
| outbound | approve | 审批出库 | boss |
| outbound | myList | 我的出库历史 | out（本人） |
| inbound | submit | 提交入库（事务） | in |
| inbound | updatePrice | 修改单价 | in（本人） |
| inbound | myList | 我的入库历史 | in（本人） |
| check | create | 创建盘点任务 | boss/admin |
| check | submit | 提交盘点结果 | in（被分配人） |
| check | review | 审核盘点差异 | boss |
| check | list | 盘点任务列表 | in/boss |
| check | report | 盘点差异报告 | boss |
| stats | overview | 总览 KPI | boss |
| stats | trend | 趋势数据 | boss |
| stats | stockList | 库存台账 | boss |
| stats | orderFlow | 单据流水 | boss |
| stats | stockFlow | 库存流水 | boss |
| stats | warning | 预警列表 | boss |
| export | csv | 导出 CSV | boss |
| user | list | 用户列表 | boss/admin |
| user | approve | 审核用户 | boss/admin |
| user | disable | 禁用用户 | boss/admin |

---

## 五、页面设计

### 5.1 小程序端页面（15 个）

| 页面 | 路径 | 功能 |
|------|------|------|
| 首页 | pages/index/index | 角色识别，显示对应入口 |
| 登录 | pages/login/login | 微信授权 + 填真实姓名 |
| 出库提交 | pages/out/submit | 选物料 → 填数量 → 选类型 → 提交 |
| 出库历史 | pages/out/history | 我的出库单列表 |
| 出库详情 | pages/out/detail | 单号、物料、数量、状态 |
| 入库提交 | pages/in/submit | 选物料 → 填数量+单价 → 提交 |
| 入库历史 | pages/in/history | 我的入库单列表 |
| 入库详情 | pages/in/detail | 单号、物料、数量、单价、供应商 |
| 盘点任务 | pages/check/list | 待盘点任务列表 |
| 盘点录入 | pages/check/submit | 逐项输入实际数量 |
| 盘点详情 | pages/check/detail | 盘点差异明细 |
| 老板总览 | pages/boss/dashboard | KPI 卡片 |
| 老板趋势 | pages/boss/trend | 出入库趋势图 |
| 库存台账 | pages/boss/stock | 所有物料当前库存 |
| 单据流水 | pages/boss/orders | 按日期/类型筛选 |
| 库存预警 | pages/boss/warning | 低库存物料列表 |
| 个人信息 | pages/my/profile | 查看/修改资料 |

### 5.2 Web 后台页面（10 个）

| 页面 | 路径 | 功能 |
|------|------|------|
| 登录 | /login | 微信扫码登录 |
| 数据看板 | /dashboard | 今日/本周/本月统计 |
| 出入库统计 | /stats/overview | 按日/周/月统计报表 |
| 物料排行 | /stats/material-rank | 出入库 Top 20 |
| 人员绩效 | /stats/operator-stats | 操作员工作量 |
| 成本趋势 | /stats/cost-trend | 库存成本变化 |
| 用户列表 | /user/list | 所有用户管理 |
| 审核用户 | /user/approve | 审核新用户，分配角色 |
| 权限矩阵 | /role/matrix | 角色权限配置 |
| 物料列表 | /material/list | 物料管理 |
| 批量导入 | /material/import | Excel 导入 |
| 出库单管理 | /order/outbound | 出库单列表 |
| 入库单管理 | /order/inbound | 入库单列表 |
| 创建盘点 | /check/create | 创建盘点任务 |
| 盘点进度 | /check/progress | 查看盘点完成情况 |
| 差异报告 | /check/report | 盘盈盘亏明细 |
| 系统设置 | /setting/company | 公司信息 |
| 预警设置 | /setting/warning | 预警阈值 |

---

## 六、实施计划（约 9.5 周）

| 阶段 | 内容 | 工期 | 产出 |
|------|------|------|------|
| 1 | 原型设计 | 1 周 | 小程序 + Web 后台可交互原型 |
| 2 | 基础设施 | 1 周 | 云开发环境 + 数据库 + 云函数骨架 |
| 3 | 核心功能 | 2 周 | 小程序出库/入库/盘点 MVP |
| 3.5 | P0 修复 | 1 周 | 库存流水 + 权限细化 + 盘点审核 |
| 4 | 看板与统计 | 1 周 | 趋势图 + 预警 + 导出 |
| 5 | Web 后台 | 1.5 周 | 用户/权限/物料/单据/盘点管理 |
| 6 | 联调测试 | 0.5 周 | 全流程测试 + 压力测试 |
| 7 | 数据初始化 | 1 周 | 物料导入 + 账号配置 |
| 8 | 上线培训 | 3 天 | 正式上线 + 员工培训 |

---

## 七、开发规范

### 7.1 代码规范

- 小程序端：uni-app + Vue3 + Composition API
- Web 后台：Vue3 + Element Plus + Vite
- 云函数：Node.js 18+
- 命名：驼峰命名（camelCase），文件用 kebab-case
- 注释：关键函数必须写 JSDoc

### 7.2 Git 提交规范

```
feat: 新功能
fix: 修复 bug
docs: 文档更新
style: 代码格式调整
refactor: 重构
test: 测试
chore: 构建/工具链
```

### 7.3 分支管理

```
main        # 生产分支，只接受 merge
develop     # 开发分支，日常开发
feature/xxx # 功能分支，从 develop 切出
hotfix/xxx  # 紧急修复，从 main 切出
```

---

## 八、进度跟踪

### 8.1 任务清单

见 `docs/tasks.md`，按周分解任务。

### 8.2 每日站会

- 昨天完成了什么
- 今天计划做什么
- 遇到什么阻塞

### 8.3 周度复盘

- 本周完成情况
- 下周计划
- 风险识别

---

## 九、风险与应对

| 风险 | 概率 | 影响 | 应对 |
|------|------|------|------|
| 云开发额度超支 | 低 | 中 | 设置预算告警 |
| 微信审核不通过 | 低 | 高 | 提前准备企业资质 |
| 员工不会用 | 中 | 中 | 5 分钟培训 + 操作手册 |
| 并发导致库存错误 | 中 | 高 | 数据库事务 + 幂等设计 |
| 网络不稳定 | 中 | 中 | 本地缓存 + 断网提示 |

---

## 十、联系与支持

- 项目负责人：坦克老师
- 技术支持：WorkBuddy AI
- 文档更新：每次重大变更后更新版本号

---

*文档版本：v2.1 | 最后更新：2026-09-28*
