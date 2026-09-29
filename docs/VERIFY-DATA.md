# 数据库验证指南

## 验证步骤

### 第 1 步：检查集合数据量

在云开发控制台 → 数据库，检查以下集合的数据量：

| 集合 | 预期数量 | 说明 |
|------|---------|------|
| warehouses | 2 | 配件仓 + 成品仓 |
| suppliers | 5 | 5 个供应商 |
| settings | 1 | 系统设置 |
| materials | 1930 | 物料数据 |
| users | 0 | 用户数据（注册后才会有） |
| outbound_orders | 0 | 出库单（使用后才产生） |
| inbound_orders | 0 | 入库单（使用后才产生） |
| stock_checks | 0 | 盘点单（使用后才产生） |
| stock_logs | 0 | 库存流水（使用后才产生） |
| operation_logs | 0 | 操作日志（使用后才产生） |

### 第 2 步：检查数据内容

**warehouses 集合：**
- peijian - 配件仓
- chengpin - 成品仓

**suppliers 集合：**
- 广州汽配供应商
- 轮胎专卖店
- 电池供应商
- 悬挂系统专供
- 制动系统专供

**settings 集合：**
- company_name: 胜龙汽配
- warning_enabled: true
- backup_enabled: true

**materials 集合：**
- 150 条成品（warehouse_id: chengpin）
- 1780 条配件（warehouse_id: peijian）

### 第 3 步：检查索引

在云开发控制台 → 数据库 → 索引管理，检查所有索引是否已创建。

---

## 常见问题

### 1. 数据量不对

如果数据量不对，重新执行初始化：
```json
{
  "action": "fullInit"
}
```

### 2. 索引未创建

索引需要手动创建，参考 `docs/CREATE-INDEXES.md`

### 3. 权限问题

确保数据库权限规则设置为：
- 所有集合：所有用户不可读写，仅云函数可读写

---

**验证完成后，系统就可以正式使用了。**
