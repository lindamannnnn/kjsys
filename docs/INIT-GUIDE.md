# 数据库初始化完整指南

## 前置条件

1. 已注册微信小程序（AppID: wxb2fd2feb972e8cbf）
2. 已开通云开发（环境 ID: cloudbase-d9gec9wmj52ac877d）
3. 已安装微信开发者工具

---

## 第一步：部署 init-db 云函数

1. 在微信开发者工具中，点击「云开发」→「云函数」
2. 点击「新建云函数」
3. 名称：`init-db`
4. 上传以下文件：
   - `cloudfunctions/init-db.js`（重命名为 `index.js`）
   - `cloudfunctions/init-db-package.json`（重命名为 `package.json`）
   - `cloudfunctions/materials-init.json`

---

## 第二步：执行初始化

在云开发控制台 → 云函数 → init-db → 测试：

### 方式 1：一键初始化（推荐）

```json
{
  "action": "fullInit"
}
```

这会依次执行：
1. 创建集合
2. 创建索引
3. 初始化数据（仓库、供应商、系统设置）
4. 清理测试数据
5. 导入真实物料数据（1930 条）

### 方式 2：分步执行

**1. 创建集合**
```json
{
  "action": "createCollections"
}
```

**2. 创建索引**
```json
{
  "action": "createIndexes"
}
```

**3. 初始化数据**
```json
{
  "action": "initData"
}
```

**4. 清理测试数据**
```json
{
  "action": "cleanTestData"
}
```

**5. 导入真实物料**
```json
{
  "action": "importMaterials"
}
```

---

## 第三步：手动创建索引（如果自动创建失败）

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

## 第四步：验证数据

在云开发控制台 → 数据库：

1. 检查 `warehouses` 集合是否有 2 条数据
2. 检查 `suppliers` 集合是否有 5 条数据
3. 检查 `settings` 集合是否有 1 条数据
4. 检查 `materials` 集合是否有 1930 条数据

---

## 第五步：部署其他云函数

按以下顺序部署：

1. `auth` - 用户认证
2. `material` - 物料管理
3. `outbound` - 出库单
4. `inbound` - 入库单
5. `check` - 盘点
6. `stats` - 统计
7. `user` - 用户管理

每个云函数的代码在 `cloudfunctions/` 目录下对应的文件夹中。

---

## 常见问题

### 1. 导入超时

如果 1930 条数据导入超时，可以：
- 减小批次大小（把 batchSize 从 50 改成 20）
- 分多次导入（先导入 500 条，再导入剩余）

### 2. 索引创建失败

索引需要在云开发控制台手动创建，云函数无法自动创建。

### 3. 权限不足

确保数据库权限规则设置为：
- 所有集合：所有用户不可读写，仅云函数可读写

---

## 完成标志

- [ ] 10 个集合全部创建
- [ ] 索引全部创建
- [ ] 仓库数据 2 条
- [ ] 供应商数据 5 条
- [ ] 系统设置 1 条
- [ ] 物料数据 1930 条
- [ ] 7 个云函数全部部署

---

**完成以上步骤后，系统就可以正式使用了。**
