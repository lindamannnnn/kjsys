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
