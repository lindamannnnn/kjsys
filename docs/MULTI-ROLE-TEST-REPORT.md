# 多角色三轮真实场景测试报告

> 测试时间：2026-09-28
> 测试方式：3 个 Agent 分别模拟车间员工、仓库管理员、老板
> 测试轮次：每角色 3 轮真实使用场景

---

## 测试角色分工

| 角色 | 姓名 | 职责 | 测试场景 |
|------|------|------|---------|
| 车间员工 | 张三 | 领料出库 | 日常领料 → 异常处理 → 历史记录 |
| 仓库管理员 | 赵六 | 入库登记、盘点 | 采购入库 → 库存盘点 → 数据核对 |
| 老板 | 王总 | 数据查看、审批、管理 | 小程序看板 → 单据流水 → Web 后台管理 |

---

## 发现的问题汇总（按优先级）

### P0 - 数据安全与正确性（7 项）

| # | 问题 | 影响 | 位置 |
|---|------|------|------|
| 1 | **历史记录未按操作人过滤** | 张三能看到李四、王五的单据，数据越权 | `pages/out/history.vue` |
| 2 | **详情页数据硬编码** | 点击不同记录显示同一份内容 | `pages/out/detail.vue` |
| 3 | **mockLogin 角色串扰** | 测试号显示全部角色入口，与身份不符 | `store/user.js` |
| 4 | **撤销按钮时间判断错误** | 任何历史单据都显示撤销按钮 | `pages/out/detail.vue` |
| 5 | **库存总量与物料档案不一致** | Web 852 vs 实际 1067 | `admin/src/views/dashboard.vue` |
| 6 | **今日出入库数据不一致** | Web 12/8 vs 小程序 4/2 | `admin/src/views/dashboard.vue` |
| 7 | **预警物料规则不一致** | 水泵在物料页显示正常，在预警列表显示预警 | 多处 mock 数据 |

### P1 - 交互体验（6 项）

| # | 问题 | 影响 | 位置 |
|---|------|------|------|
| 8 | **超库存时按钮置灰但无文字提示** | 用户不知道为什么不能提交 | `pages/out/submit.vue` |
| 9 | **数量输入未限制小数/负数** | 可输入 1.5 个活塞，业务不合理 | `pages/out/submit.vue` |
| 10 | **提交成功后未跳转到历史记录** | 用户无法立刻确认单据已入账 | `pages/out/submit.vue` |
| 11 | **单据流水无法点击查看详情** | 老板无法查看单据详情 | `pages/boss/orders.vue` |
| 12 | **单据流水日期筛选未生效** | 筛选无效 | `pages/boss/orders.vue` |
| 13 | **趋势分析图表为纯 CSS 模拟** | 无真实数据曲线 | `pages/boss/trend.vue` |

### P2 - 业务一致性（3 项）

| # | 问题 | 影响 | 位置 |
|---|------|------|------|
| 14 | **出库类型枚举不一致** | 提交页 4 种 vs mockData 含销售 | `pages/out/submit.vue` |
| 15 | **Web 后台所有操作均为本地模拟** | 刷新后丢失，无后端持久化 | `admin/src/views/user/list.vue` 等 |
| 16 | **盘点管理无可审核的盘点单** | mock 数据缺少 pending_review 状态 | `admin/src/views/check/list.vue` |

---

## 修复建议（按优先级）

### 立即修复（P0）

1. **历史记录按操作人过滤**
   ```javascript
   // pages/out/history.vue
   const mockList = mockOutboundOrders.filter(o => o.operator_name === currentUser.real_name)
   ```

2. **详情页根据 ID 查询**
   ```javascript
   // pages/out/detail.vue
   const order = mockOutboundOrders.find(o => o._id === orderId)
   ```

3. **mockLogin 按角色显示**
   ```javascript
   // store/user.js
   // 测试号只显示当前角色，或提供角色切换
   ```

4. **撤销按钮时间判断**
   ```javascript
   // pages/out/detail.vue
   // 使用真实 created_at 时间判断
   ```

5. **统一数据源**
   ```javascript
   // 引入 Pinia store 集中管理物料、单据、预警数据
   // 各页面从 store 读取，而非各自硬编码
   ```

### 近期修复（P1）

6. **超库存提示**
   ```javascript
   // pages/out/submit.vue
   // 输入框下方显示红字提示
   ```

7. **数量输入限制**
   ```javascript
   // 限制为正整数
   ```

8. **提交后跳转**
   ```javascript
   // 提交成功后跳转到历史记录页
   ```

9. **单据流水点击详情**
   ```javascript
   // pages/boss/orders.vue
   // 添加 @click 跳转到详情页
   ```

10. **日期筛选生效**
    ```javascript
    // 按 startDate/endDate 过滤
    ```

### 后续优化（P2）

11. **统一出库类型枚举**
12. **Web 后台接入真实后端**
13. **补充盘点审核测试数据**

---

## 测试结论

当前版本为**高保真原型/演示版本**，UI 层完成度较高，角色权限和页面流程设计合理。但**数据层完全依赖前端 mock**，存在多处数据不一致和交互断点。

**不具备上线条件**，建议：
1. 先修复 P0 问题（数据安全与正确性）
2. 再修复 P1 问题（交互体验）
3. 打通云函数与数据库
4. 进行真实环境回归测试

---

**测试报告生成时间**：2026-09-28
