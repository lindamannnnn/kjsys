# 功能补齐计划

> 目标：让微信小程序版功能达到 V3.1 统一入口版水平
> 工期：约 16 天
> 更新：2026-09-29 - 添加多仓库支持（配件仓/成品仓）

---

## 一、需要补齐的功能清单

| # | 功能 | 优先级 | 预估工期 | 状态 |
|---|------|--------|---------|------|
| 1 | 采购员角色 | P0 | 3 天 | [ ] |
| 2 | 仓管确认环节 | P0 | 5 天 | [ ] |
| 3 | 作废单据功能 | P0 | 3 天 | [ ] |
| 4 | 批量操作（领料清单/入库清单） | P1 | 5 天 | [ ] |
| 5 | 数量快捷键 | P2 | 1 天 | [ ] |
| 6 | **多仓库支持（配件仓/成品仓）** | **P0** | **3 天** | **[ ]** |

---

## 二、详细功能设计

### 0. 多仓库支持（3 天）

**背景：**
- V3.1 有 2 个仓库：配件仓（peijian001）、成品仓（chengpin001）
- 每个仓库有独立的仓管员
- 物料按仓库分类管理

**新增功能：**
- 物料表添加 warehouse_id 字段
- 用户表添加 warehouse_ids 字段（所属仓库）
- 仓管员只能看到自己仓库的单据和库存
- 老板可以看到所有仓库

**仓库定义：**
- 配件仓（warehouse_id: 'peijian'）
- 成品仓（warehouse_id: 'chengpin'）

**修改文件：**
- `miniprogram/src/utils/mockData.js` - 物料添加 warehouse_id，用户添加 warehouse_ids
- `miniprogram/src/pages/index/index.vue` - 仓管员显示所属仓库
- `miniprogram/src/pages/storekeeper/dashboard.vue` - 按仓库筛选
- `miniprogram/src/pages/boss/dashboard.vue` - 显示所有仓库

---

### 1. 采购员角色（3 天）

**新增角色：采购员（purchase）**

**权限：**
- 提交入库单（含单价、供应商）
- 查看自己的入库记录
- 查看物料库存（仅数量，无成本）

**页面：**
- 采购员首页入口（蓝色卡片，图标 🛒）
- 采购入库提交页（与现有 in/submit 类似，但角色为 purchase）
- 采购入库历史页

**数据库：**
- users 集合 roles 添加 'purchase'

**修改文件：**
- `miniprogram/src/store/user.js` - mockLogin 支持 'purchase' 角色
- `miniprogram/src/pages/index/index.vue` - 添加采购员入口
- `miniprogram/src/utils/mockData.js` - 添加采购员相关数据
- `miniprogram/src/pages/purchase/submit.vue` - 新建
- `miniprogram/src/pages/purchase/history.vue` - 新建
- `miniprogram/src/pages/purchase/detail.vue` - 新建

---

### 2. 仓管确认环节（5 天）

**核心流程变更：**
```
旧流程：提交 → 直接生效
新流程：提交 → 待确认 → 仓管确认 → 生效
```

**新增角色权限：**
- 仓管员（storekeeper）可以确认/作废单据

**新增页面：**
- 仓管工作台（storekeeper/dashboard.vue）
  - 待确认列表（默认页）
  - 全部流水
  - 盘点
  - 库存

**新增功能：**
- 批量确认（勾选多张单据一次确认）
- 作废单据（填写原因，库存自动回算）

**数据库：**
- outbound_orders 和 inbound_orders 添加状态字段：
  - pending（待确认）
  - confirmed（已确认）
  - cancelled（已作废）
- 新增 operation_logs 记录确认/作废操作

**修改文件：**
- `miniprogram/src/pages/storekeeper/dashboard.vue` - 新建
- `miniprogram/src/pages/storekeeper/pending.vue` - 新建（待确认列表）
- `miniprogram/src/pages/storekeeper/orders.vue` - 新建（全部流水）
- `miniprogram/src/pages/storekeeper/check.vue` - 新建（盘点）
- `miniprogram/src/pages/storekeeper/stock.vue` - 新建（库存）
- `miniprogram/src/utils/mockData.js` - 添加待确认状态数据

---

### 3. 作废单据功能（3 天）

**功能：**
- 仓管员可作废已提交的单据
- 作废时填写原因
- 作废后库存自动回算
- 操作留痕（谁、何时、原因）

**新增页面：**
- 作废确认弹窗（在仓管工作台）

**数据库：**
- outbound_orders 和 inbound_orders 添加：
  - status: 'cancelled'
  - cancel_reason: String
  - cancel_operator_openid: String
  - cancel_operator_name: String
  - cancelled_at: Date

**修改文件：**
- `miniprogram/src/pages/storekeeper/pending.vue` - 添加作废按钮
- `miniprogram/src/pages/storekeeper/orders.vue` - 显示作废状态
- `miniprogram/src/utils/mockData.js` - 添加作废相关数据

---

### 4. 批量操作（5 天）

**功能：**
- 领料清单：一次可领多种物料
- 入库清单：一次可入库多种物料
- 清单临时保存（中途退出再进来还在）

**新增组件：**
- MaterialPicker.vue（物料选择器，支持多选）
- OrderList.vue（清单列表）

**修改页面：**
- `miniprogram/src/pages/out/submit.vue` - 改为清单模式
- `miniprogram/src/pages/in/submit.vue` - 改为清单模式
- `miniprogram/src/pages/purchase/submit.vue` - 清单模式

**数据结构：**
```javascript
// 领料清单
const outOrderList = [
  { material_id: 'm001', material_name: '发动机活塞', quantity: 4, remark: '' },
  { material_id: 'm002', material_name: '刹车片', quantity: 2, remark: '' }
]

// 提交时生成一张单据，包含多个物料
{
  order_no: 'OUT-20260928-001',
  items: [
    { material_id: 'm001', material_name: '发动机活塞', quantity: 4 },
    { material_id: 'm002', material_name: '刹车片', quantity: 2 }
  ],
  operator_openid: 'xxx',
  created_at: Date
}
```

**修改文件：**
- `miniprogram/src/pages/out/submit.vue` - 改为清单模式
- `miniprogram/src/pages/in/submit.vue` - 改为清单模式
- `miniprogram/src/pages/purchase/submit.vue` - 清单模式
- `miniprogram/src/components/MaterialPicker.vue` - 新建
- `miniprogram/src/components/OrderList.vue` - 新建

---

### 5. 数量快捷键（1 天）

**功能：**
- 数量输入框旁添加快捷键：10 / 50 / 100 / 500
- 点击快捷键自动填入对应数量

**修改文件：**
- `miniprogram/src/pages/out/submit.vue` - 添加数量快捷键
- `miniprogram/src/pages/in/submit.vue` - 添加数量快捷键
- `miniprogram/src/pages/purchase/submit.vue` - 添加数量快捷键

---

## 三、实施顺序

### 阶段 1：基础角色（第 1-3 天）
- 采购员角色
- 采购员入口和页面

### 阶段 2：仓管确认（第 4-8 天）
- 仓管工作台
- 待确认列表
- 确认/作废功能
- 批量确认

### 阶段 3：批量操作（第 9-13 天）
- 领料清单
- 入库清单
- 清单临时保存

### 阶段 4：细节优化（第 14-16 天）
- 数量快捷键
- 测试和修复

---

## 四、角色权限对照表（补齐后）

| 功能 | 领用员 | 采购员 | 仓管员（配件仓） | 仓管员（成品仓） | 老板 |
|------|--------|--------|-----------------|-----------------|------|
| 提交领料单 | ✅ | ❌ | ❌ | ❌ | ❌ |
| 提交入库单 | ❌ | ✅ | ❌ | ❌ | ❌ |
| 确认/作废单据 | ❌ | ❌ | ✅（配件仓） | ✅（成品仓） | ✅ |
| 盘点 | ❌ | ❌ | ✅（配件仓） | ✅（成品仓） | ❌ |
| 查看库存数量 | ✅ | ✅ | ✅（配件仓） | ✅（成品仓） | ✅（全部） |
| 查看成本/金额 | ❌ | ❌ | ✅（配件仓） | ✅（成品仓） | ✅（全部） |
| 查看全部单据 | ❌ | ❌ | ✅（配件仓） | ✅（成品仓） | ✅（全部） |
| 查看本人单据 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 人员管理 | ❌ | ❌ | ❌ | ❌ | ✅ |
| 导出数据 | ❌ | ❌ | ✅（配件仓） | ✅（成品仓） | ✅（全部） |

---

## 五、数据库变更

### users 集合

```javascript
{
  _id: String,
  _openid: String,
  nickname: String,
  avatar: String,
  real_name: String,
  phone: String,
  roles: ['out', 'in', 'purchase', 'storekeeper', 'boss', 'admin'],
  warehouse_ids: ['peijian', 'chengpin'], // 所属仓库，老板为全部
  status: 'active'/'disabled'/'pending',
  created_at: Date,
  last_login_at: Date
}
```

### warehouses 集合（新增）

```javascript
{
  _id: String,
  name: String, // 配件仓/成品仓
  code: String, // peijian/chengpin
  description: String,
  created_at: Date
}
```

### materials 集合

```javascript
{
  _id: String,
  name: String,
  category: String,
  unit: String,
  spec: String,
  barcode: String,
  warehouse_id: String, // 所属仓库
  current_stock: Number,
  warning_stock: Number,
  avg_cost: Number,
  image_fileid: String,
  is_deleted: Boolean,
  created_at: Date,
  updated_at: Date
}
```

### outbound_orders 集合

```javascript
{
  _id: String,
  order_no: String,
  warehouse_id: String, // 所属仓库
  items: [{
    material_id: String,
    material_name: String,
    material_spec: String,
    quantity: Number,
    unit: String
  }],
  operator_openid: String,
  operator_name: String,
  remark: String,
  status: 'pending'/'confirmed'/'cancelled',
  confirm_operator_openid: String,
  confirm_operator_name: String,
  confirmed_at: Date,
  cancel_operator_openid: String,
  cancel_operator_name: String,
  cancel_reason: String,
  cancelled_at: Date,
  created_at: Date
}
```

### inbound_orders 集合

```javascript
{
  _id: String,
  order_no: String,
  warehouse_id: String, // 所属仓库
  items: [{
    material_id: String,
    material_name: String,
    material_spec: String,
    quantity: Number,
    unit: String,
    unit_price: Number,
    total_price: Number
  }],
  supplier: String,
  operator_openid: String,
  operator_name: String,
  remark: String,
  status: 'pending'/'confirmed'/'cancelled',
  confirm_operator_openid: String,
  confirm_operator_name: String,
  confirmed_at: Date,
  cancel_operator_openid: String,
  cancel_operator_name: String,
  cancel_reason: String,
  cancelled_at: Date,
  created_at: Date
}
```

---

## 六、页面结构（补齐后）

```
pages/
├── index/index              # 首页（角色识别 + 仓库识别）
├── login/login              # 登录
├── out/                     # 领用员
│   ├── submit               # 领料出库（清单模式）
│   ├── history              # 出库历史
│   └── detail               # 出库详情
├── purchase/                # 采购员（新增）
│   ├── submit               # 采购入库（清单模式）
│   ├── history              # 入库历史
│   └── detail               # 入库详情
├── in/                      # 仓库管理员（保留，用于盘点）
│   ├── submit               # 入库登记（清单模式）
│   ├── history              # 入库历史
│   └── detail               # 入库详情
├── storekeeper/             # 仓管员（新增，按仓库区分）
│   ├── dashboard            # 仓管工作台（显示所属仓库）
│   ├── pending              # 待确认列表（仅本仓库）
│   ├── orders               # 全部流水（仅本仓库）
│   ├── check                # 盘点（仅本仓库）
│   └── stock                # 库存（仅本仓库）
├── check/                   # 盘点（保留）
│   ├── list                 # 盘点任务列表
│   ├── submit               # 盘点录入
│   └── detail               # 盘点详情
├── boss/                    # 老板（可看所有仓库）
│   ├── dashboard            # 数据看板（全部仓库）
│   ├── trend                # 趋势分析（全部仓库）
│   ├── stock                # 库存台账（全部仓库）
│   ├── orders               # 单据流水（全部仓库）
│   └── warning              # 库存预警（全部仓库）
└── my/                      # 我的
    └── profile              # 个人信息（显示所属仓库）
```

---

**计划生成时间**：2026-09-29
**更新时间**：2026-09-29（添加多仓库支持）
