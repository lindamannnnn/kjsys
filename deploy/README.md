# 胜龙进销存 - 部署文件清单

## 目录结构

```
deploy/
├── cloudfunctions/          # 云函数
│   ├── init-db/             # 数据库初始化
│   │   ├── index.js         # 主文件
│   │   ├── package.json     # 依赖配置
│   │   └── materials-init.json  # 物料数据（1930 条）
│   ├── import-materials/    # 物料导入
│   │   ├── index.js         # 主文件
│   │   ├── package.json     # 依赖配置
│   │   └── materials-init.json  # 物料数据
│   ├── auth/                # 用户认证
│   ├── material/            # 物料管理
│   ├── outbound/            # 出库单
│   ├── inbound/             # 入库单
│   ├── check/               # 盘点
│   ├── stats/               # 统计
│   └── user/                # 用户管理
├── miniprogram/             # 小程序（编译后）
│   └── dist/build/mp-weixin/
└── admin/                   # Web 后台（编译后）
    └── dist/
```

---

## 部署步骤

### 第 1 步：部署 init-db 云函数

1. 打开微信开发者工具
2. 点击「云开发」→「云函数」
3. 点击「新建云函数」
4. 名称：`init-db`
5. 上传 `deploy/cloudfunctions/init-db/` 目录下的文件
6. 点击「上传并部署」

### 第 2 步：执行数据库初始化

1. 在云开发控制台 → 云函数 → init-db
2. 点击「测试」
3. 传入参数：
```json
{
  "action": "fullInit"
}
```
4. 点击「运行测试」
5. 等待执行完成

### 第 3 步：部署其他云函数

按以下顺序部署：

1. `auth` - 用户认证
2. `material` - 物料管理
3. `outbound` - 出库单
4. `inbound` - 入库单
5. `check` - 盘点
6. `stats` - 统计
7. `user` - 用户管理

每个云函数的部署方式：
1. 新建云函数
2. 上传对应目录下的 `index.js` 和 `package.json`
3. 点击「上传并部署」

### 第 4 步：创建数据库索引

在云开发控制台 → 数据库 → 索引管理，创建以下索引：

**users 集合**
- openid: 唯一索引
- status: 普通索引
- roles: 普通索引

**materials 集合**
- warehouse_id: 普通索引
- category: 普通索引
- name: 普通索引

**outbound_orders 集合**
- order_no: 唯一索引
- status: 普通索引
- operator_openid: 普通索引
- created_at: 普通索引

**inbound_orders 集合**
- order_no: 唯一索引
- status: 普通索引
- operator_openid: 普通索引
- supplier: 普通索引
- created_at: 普通索引

**stock_checks 集合**
- check_no: 唯一索引
- status: 普通索引
- assignee_openids: 普通索引

**stock_logs 集合**
- material_id: 普通索引
- created_at: 普通索引
- related_order_id: 普通索引

**operation_logs 集合**
- openid: 普通索引
- created_at: 普通索引

### 第 5 步：验证数据

在云开发控制台 → 数据库：

1. 检查 `warehouses` 集合是否有 2 条数据
2. 检查 `suppliers` 集合是否有 5 条数据
3. 检查 `settings` 集合是否有 1 条数据
4. 检查 `materials` 集合是否有 1930 条数据

### 第 6 步：测试系统

1. 在微信开发者工具中点击「编译」
2. 测试登录功能
3. 测试出库/入库功能
4. 测试盘点功能
5. 测试老板看板

---

## 部署完成后的检查清单

- [ ] 10 个集合全部创建
- [ ] 索引全部创建
- [ ] 仓库数据 2 条
- [ ] 供应商数据 5 条
- [ ] 系统设置 1 条
- [ ] 物料数据 1930 条
- [ ] 7 个云函数全部部署
- [ ] 小程序可以正常登录
- [ ] 出库/入库功能正常
- [ ] 盘点功能正常
- [ ] 老板看板数据正常

---

## 常见问题

### 1. 云函数调用失败

检查：
- 云函数是否已部署
- 云开发环境是否正确选择
- 数据库权限是否正确设置

### 2. 数据库查询为空

检查：
- 集合是否已创建
- 索引是否已创建
- 数据是否已初始化

### 3. 权限不足

检查：
- 用户 roles 是否正确设置
- 数据库权限规则是否正确

---

**部署完成后，系统就可以正式使用了。**
