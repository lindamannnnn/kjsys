# 数据库初始化脚本

> 在云开发控制台「数据库」标签页中执行

## 1. 创建集合

在云开发控制台依次创建以下集合：

| 集合名 | 用途 |
|--------|------|
| users | 用户与角色 |
| materials | 物料档案 |
| outbound_orders | 出库单 |
| inbound_orders | 入库单 |
| stock_checks | 盘点单 |
| stock_logs | 库存流水 |
| suppliers | 供应商 |
| operation_logs | 操作日志 |
| settings | 系统配置 |

## 2. 配置安全规则

在云开发控制台「数据库」→「权限设置」中配置：

### users

```javascript
{
  "read": "auth != null",
  "write": false
}
```

### materials

```javascript
{
  "read": "auth != null",
  "write": false
}
```

### outbound_orders

```javascript
{
  "read": "auth != null",
  "write": false
}
```

### inbound_orders

```javascript
{
  "read": "auth != null",
  "write": false
}
```

### stock_checks

```javascript
{
  "read": "auth != null",
  "write": false
}
```

### stock_logs

```javascript
{
  "read": "auth != null",
  "write": false
}
```

### suppliers

```javascript
{
  "read": "auth != null",
  "write": false
}
```

### operation_logs

```javascript
{
  "read": "auth != null",
  "write": false
}
```

### settings

```javascript
{
  "read": "auth != null",
  "write": false
}
```

**注意**：所有集合的 write 都设为 false，写操作只能通过云函数执行。

## 3. 初始化 settings 集合

在云开发控制台「数据库」→「settings」集合中手动插入：

```javascript
{
  "_id": "global",
  "company_name": "胜龙汽配",
  "warning_enabled": true,
  "warning_notify_boss": true,
  "backup_enabled": true,
  "boss_openids": [],
  "order_no_prefix_out": "OUT",
  "order_no_prefix_in": "IN"
}
```

## 4. 创建第一个 boss 用户

在云开发控制台「数据库」→「users」集合中手动插入：

```javascript
{
  "_openid": "YOUR_OPENID_HERE",
  "nickname": "老板",
  "avatar": "",
  "real_name": "老板",
  "phone": "",
  "roles": ["boss", "admin"],
  "warehouse_ids": [],
  "status": "active",
  "created_at": new Date(),
  "last_login_at": new Date()
}
```

**注意**：将 `YOUR_OPENID_HERE` 替换为实际的微信 openid。

## 5. 创建索引

在云开发控制台「数据库」→ 各集合的「索引管理」中创建：

### materials

- name（普通索引）
- category（普通索引）
- current_stock（普通索引）

### outbound_orders

- created_at（普通索引，降序）
- material_id（普通索引）
- operator_openid（普通索引）

### inbound_orders

- created_at（普通索引，降序）
- material_id（普通索引）
- operator_openid（普通索引）

### stock_logs

- material_id（普通索引）
- created_at（普通索引，降序）

### operation_logs

- openid（普通索引）
- created_at（普通索引，降序）

---

*执行完成后，数据库初始化完成*
