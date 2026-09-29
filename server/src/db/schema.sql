-- =====================================================
-- 胜龙进销存系统 · 数据库建表脚本
-- 数据库：MySQL 8.0 / utf8mb4
-- 说明：由原云开发 10 个集合映射而来，单据明细拆分为独立表
-- 幂等：全部使用 IF NOT EXISTS，可重复执行
-- =====================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- -----------------------------------------------------
-- 1. warehouses 仓库（配件仓 / 成品仓）
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `warehouses` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code`       VARCHAR(32)  NOT NULL COMMENT '仓库编码，如 peijian / chengpin',
  `name`       VARCHAR(64)  NOT NULL COMMENT '仓库名称',
  `sort_order` INT          NOT NULL DEFAULT 0,
  `is_deleted` TINYINT      NOT NULL DEFAULT 0,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_warehouse_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='仓库';

-- -----------------------------------------------------
-- 2. users 用户与角色
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `users` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `openid`        VARCHAR(64)  DEFAULT NULL COMMENT '微信 openid（小程序用户）',
  `username`      VARCHAR(50)  DEFAULT NULL COMMENT '后台登录账号（Web 后台用户）',
  `password_hash` VARCHAR(255) DEFAULT NULL COMMENT '后台密码 bcrypt 哈希',
  `nickname`      VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '微信昵称',
  `avatar`        VARCHAR(512) NOT NULL DEFAULT '' COMMENT '微信头像',
  `real_name`     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '真实姓名',
  `phone`         VARCHAR(20)  NOT NULL DEFAULT '' COMMENT '手机号',
  `roles`         JSON         DEFAULT NULL COMMENT '角色数组 ["out","in","purchase","storekeeper","boss","admin"]',
  `warehouse_ids` JSON         DEFAULT NULL COMMENT '可操作仓库 id 数组，NULL 表示全部',
  `status`        ENUM('pending','active','disabled') NOT NULL DEFAULT 'pending',
  `must_change_password` TINYINT NOT NULL DEFAULT 0 COMMENT '1=首次登录必须改密（防止默认密码长期有效）',
  `created_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_login_at` DATETIME     DEFAULT NULL,
  `updated_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_openid`   (`openid`),
  UNIQUE KEY `uk_user_username` (`username`),
  KEY `idx_user_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户与角色';

-- -----------------------------------------------------
-- 3. materials 物料档案
--    注意：不加 (name,spec,warehouse_id) 唯一约束 —— 真实历史数据存在同名重复，加约束会导致导入失败；
--         去重由应用层在导入时按策略处理（见 import-materials.js）
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `materials` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`           VARCHAR(191) NOT NULL COMMENT '物料名称',
  `spec`           VARCHAR(191) NOT NULL DEFAULT '' COMMENT '规格型号',
  `category`       VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '分类（配件/成品等大类）',
  `sub_category`   VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '细分类（成品仓=车间，配件仓=编号类目）',
  `material_no`    VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '物料编号（配件仓=A001-1 形式，成品仓留空）',
  `unit`           VARCHAR(16)  NOT NULL DEFAULT '个' COMMENT '单位',
  `barcode`        VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '条码（预留）',
  `warehouse_id`   BIGINT UNSIGNED NOT NULL COMMENT '所属仓库',
  `current_stock`  DECIMAL(14,3) NOT NULL DEFAULT 0.000 COMMENT '当前库存',
  `warning_stock`  DECIMAL(14,3) NOT NULL DEFAULT 10.000 COMMENT '预警库存',
  `avg_cost`       DECIMAL(14,4) NOT NULL DEFAULT 0.0000 COMMENT '移动加权平均成本',
  `image_fileid`   VARCHAR(255) NOT NULL DEFAULT '' COMMENT '物料图片',
  `remark`         VARCHAR(255) NOT NULL DEFAULT '',
  `is_deleted`     TINYINT      NOT NULL DEFAULT 0,
  `created_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_mat_warehouse` (`warehouse_id`, `is_deleted`),
  KEY `idx_mat_name`      (`name`),
  KEY `idx_mat_category`  (`warehouse_id`, `category`, `is_deleted`),
  KEY `idx_mat_sub_category` (`warehouse_id`, `sub_category`, `is_deleted`),
  KEY `idx_mat_no`          (`warehouse_id`, `material_no`, `is_deleted`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='物料档案';

-- -----------------------------------------------------
-- 4. suppliers 供应商
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `suppliers` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(128) NOT NULL,
  `contact`    VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '联系人',
  `phone`      VARCHAR(32)  NOT NULL DEFAULT '',
  `tax_no`     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '税号/纳税人识别号（开票、对账用）',
  `payment_terms` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '账期，如 月结30天（排付款计划用）',
  `address`    VARCHAR(255) NOT NULL DEFAULT '',
  `remark`     VARCHAR(255) NOT NULL DEFAULT '',
  `is_deleted` TINYINT      NOT NULL DEFAULT 0,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_supplier_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='供应商';

-- -----------------------------------------------------
-- 5. outbound_orders 出库单（主表）
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `outbound_orders` (
  `id`                       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_no`                 VARCHAR(32)  NOT NULL COMMENT '单号 OUT-20260929-001',
  `warehouse_id`             BIGINT UNSIGNED NOT NULL,
  `type`                     VARCHAR(32)  NOT NULL DEFAULT 'lingyong' COMMENT '领用/销售/报废/赠品/调整/采购退货',
  `operator_openid`          VARCHAR(64)  NOT NULL DEFAULT '',
  `operator_name`            VARCHAR(64)  NOT NULL DEFAULT '',
  `remark`                   VARCHAR(255) NOT NULL DEFAULT '',
  `status`                   ENUM('pending','confirmed','cancelled','rejected') NOT NULL DEFAULT 'pending',
  `confirm_operator_openid`  VARCHAR(64)  DEFAULT NULL,
  `confirm_operator_name`    VARCHAR(64)  DEFAULT NULL,
  `confirmed_at`             DATETIME     DEFAULT NULL,
  `reject_reason`            VARCHAR(255) DEFAULT NULL,
  `reject_operator_openid`   VARCHAR(64)  DEFAULT NULL,
  `reject_operator_name`     VARCHAR(64)  DEFAULT NULL,
  `rejected_at`              DATETIME     DEFAULT NULL,
  `cancelled_at`             DATETIME     DEFAULT NULL,
  `cancel_operator_openid`   VARCHAR(64)  DEFAULT NULL COMMENT '作废/撤销人（留痕，便于追责）',
  `cancel_operator_name`     VARCHAR(64)  DEFAULT NULL,
  `cancel_reason`            VARCHAR(255) DEFAULT NULL COMMENT '作废/撤销原因',
  `client_request_id`        VARCHAR(64)  DEFAULT NULL COMMENT '幂等键：同一请求重复提交只生效一次',
  `is_deleted`               TINYINT      NOT NULL DEFAULT 0,
  `created_at`               DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`               DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_out_order_no`  (`order_no`),
  UNIQUE KEY `uk_out_client_id` (`client_request_id`),
  KEY `idx_out_operator` (`operator_openid`, `created_at`),
  KEY `idx_out_status`   (`status`, `created_at`),
  KEY `idx_out_wh`       (`warehouse_id`, `created_at`),
  KEY `idx_out_created`  (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='出库单';

-- -----------------------------------------------------
-- 6. outbound_order_items 出库单明细
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `outbound_order_items` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id`      BIGINT UNSIGNED NOT NULL,
  `material_id`   BIGINT UNSIGNED NOT NULL,
  `material_name` VARCHAR(191) NOT NULL DEFAULT '' COMMENT '冗余，防物料改名后单据失真',
  `material_spec` VARCHAR(191) NOT NULL DEFAULT '',
  `quantity`      DECIMAL(14,3) NOT NULL DEFAULT 0,
  `unit`          VARCHAR(16)  NOT NULL DEFAULT '',
  PRIMARY KEY (`id`),
  KEY `idx_oi_order`    (`order_id`),
  KEY `idx_oi_material` (`material_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='出库单明细';

-- -----------------------------------------------------
-- 7. inbound_orders 入库单（主表）
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `inbound_orders` (
  `id`                       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_no`                 VARCHAR(32)  NOT NULL COMMENT '单号 IN-20260929-001',
  `warehouse_id`             BIGINT UNSIGNED NOT NULL,
  `type`                     VARCHAR(32)  NOT NULL DEFAULT 'purchase' COMMENT '采购入库/销售退货/调整',
  `supplier`                 VARCHAR(128) NOT NULL DEFAULT '',
  `supplier_id`              BIGINT UNSIGNED DEFAULT NULL,
  `total_price`              DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `operator_openid`          VARCHAR(64)  NOT NULL DEFAULT '',
  `operator_name`            VARCHAR(64)  NOT NULL DEFAULT '',
  `remark`                   VARCHAR(255) NOT NULL DEFAULT '',
  `status`                   ENUM('pending','confirmed','cancelled') NOT NULL DEFAULT 'pending',
  `confirm_operator_openid`  VARCHAR(64)  DEFAULT NULL,
  `confirm_operator_name`    VARCHAR(64)  DEFAULT NULL,
  `confirmed_at`             DATETIME     DEFAULT NULL,
  `cancelled_at`             DATETIME     DEFAULT NULL,
  `cancel_operator_openid`   VARCHAR(64)  DEFAULT NULL COMMENT '作废/撤销人（留痕，便于追责）',
  `cancel_operator_name`     VARCHAR(64)  DEFAULT NULL,
  `cancel_reason`            VARCHAR(255) DEFAULT NULL COMMENT '作废/撤销原因',
  `client_request_id`        VARCHAR(64)  DEFAULT NULL,
  `is_deleted`               TINYINT      NOT NULL DEFAULT 0,
  `created_at`               DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`               DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_in_order_no`  (`order_no`),
  UNIQUE KEY `uk_in_client_id` (`client_request_id`),
  KEY `idx_in_operator` (`operator_openid`, `created_at`),
  KEY `idx_in_status`   (`status`, `created_at`),
  KEY `idx_in_wh`       (`warehouse_id`, `created_at`),
  KEY `idx_in_supplier` (`supplier`),
  KEY `idx_in_created`  (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='入库单';

-- -----------------------------------------------------
-- 8. inbound_order_items 入库单明细
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `inbound_order_items` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id`      BIGINT UNSIGNED NOT NULL,
  `material_id`   BIGINT UNSIGNED NOT NULL,
  `material_name` VARCHAR(191) NOT NULL DEFAULT '',
  `material_spec` VARCHAR(191) NOT NULL DEFAULT '',
  `quantity`      DECIMAL(14,3) NOT NULL DEFAULT 0,
  `unit`          VARCHAR(16)  NOT NULL DEFAULT '',
  `unit_price`    DECIMAL(14,4) NOT NULL DEFAULT 0,
  `total_price`   DECIMAL(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_ii_order`    (`order_id`),
  KEY `idx_ii_material` (`material_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='入库单明细';

-- -----------------------------------------------------
-- 9. stock_checks 盘点单（主表）
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `stock_checks` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `check_no`          VARCHAR(32)  NOT NULL COMMENT '单号 CHK-20260929-001',
  `warehouse_id`      BIGINT UNSIGNED NOT NULL,
  `type`              VARCHAR(32)  NOT NULL DEFAULT 'full' COMMENT 'full 全盘 / sample 抽盘 / cycle 循环',
  `status`            ENUM('pending','in_progress','pending_review','completed','cancelled') NOT NULL DEFAULT 'pending',
  `freeze_stock`      TINYINT      NOT NULL DEFAULT 0 COMMENT '盘点期间是否锁定库存',
  `assignee_openids`  JSON         DEFAULT NULL COMMENT '盘点人员 openid 数组',
  `scope`             JSON         DEFAULT NULL COMMENT '盘点范围 {categories:[],material_ids:[]}',
  `remark`            VARCHAR(255) NOT NULL DEFAULT '' COMMENT '盘点说明（为什么盘、抽盘原因等）',
  `operator_openid`   VARCHAR(64)  NOT NULL DEFAULT '',
  `operator_name`     VARCHAR(64)  NOT NULL DEFAULT '',
  `reviewer_openid`   VARCHAR(64)  DEFAULT NULL,
  `reviewer_name`     VARCHAR(64)  DEFAULT NULL,
  `reviewed_at`       DATETIME     DEFAULT NULL,
  `created_at`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `completed_at`      DATETIME     DEFAULT NULL,
  `updated_at`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_check_no` (`check_no`),
  KEY `idx_check_status` (`status`, `created_at`),
  KEY `idx_check_wh`     (`warehouse_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='盘点单';

-- -----------------------------------------------------
-- 10. stock_check_items 盘点明细（由原内嵌数组拆出）
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `stock_check_items` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `check_id`      BIGINT UNSIGNED NOT NULL,
  `material_id`   BIGINT UNSIGNED NOT NULL,
  `material_name` VARCHAR(191) NOT NULL DEFAULT '',
  `material_spec` VARCHAR(191) NOT NULL DEFAULT '',
  `unit`          VARCHAR(16)  NOT NULL DEFAULT '',
  `book_stock`    DECIMAL(14,3) NOT NULL DEFAULT 0 COMMENT '账面库存',
  `actual_stock`  DECIMAL(14,3) DEFAULT NULL COMMENT '实际库存（未录入为 NULL）',
  `difference`    DECIMAL(14,3) DEFAULT NULL COMMENT '差异 = 实际 - 账面',
  `is_checked`    TINYINT      NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_check_material` (`check_id`, `material_id`),
  KEY `idx_ci_check` (`check_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='盘点明细';

-- -----------------------------------------------------
-- 11. stock_logs 库存流水（审计命脉）
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `stock_logs` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `material_id`       BIGINT UNSIGNED NOT NULL,
  `material_name`     VARCHAR(191) NOT NULL DEFAULT '',
  `warehouse_id`      BIGINT UNSIGNED DEFAULT NULL,
  `change_type`       VARCHAR(32)  NOT NULL COMMENT 'inbound/outbound/outbound_cancel/check/check_cancel/adjust/transfer',
  `change_quantity`   DECIMAL(14,3) NOT NULL COMMENT '正数=增加，负数=减少',
  `before_stock`      DECIMAL(14,3) NOT NULL,
  `after_stock`       DECIMAL(14,3) NOT NULL,
  `related_order_id`  VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '关联单号',
  `related_order_type` VARCHAR(32) NOT NULL DEFAULT '',
  `operator_openid`   VARCHAR(64)  NOT NULL DEFAULT '',
  `operator_name`     VARCHAR(64)  NOT NULL DEFAULT '',
  `remark`            VARCHAR(255) NOT NULL DEFAULT '',
  `created_at`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_log_material` (`material_id`, `created_at`),
  KEY `idx_log_order`    (`related_order_id`),
  KEY `idx_log_created`  (`created_at`),
  KEY `idx_log_operator` (`operator_openid`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='库存流水';

-- -----------------------------------------------------
-- 12. operation_logs 操作日志
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `operation_logs` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `openid`      VARCHAR(64)  NOT NULL DEFAULT '',
  `user_name`   VARCHAR(64)  NOT NULL DEFAULT '',
  `role`        VARCHAR(32)  NOT NULL DEFAULT '',
  `action`      VARCHAR(64)  NOT NULL COMMENT 'login / outbound_submit / ...',
  `target_type` VARCHAR(32)  NOT NULL DEFAULT '',
  `target_id`   VARCHAR(64)  NOT NULL DEFAULT '',
  `detail`      VARCHAR(512) NOT NULL DEFAULT '',
  `result`      VARCHAR(16)  NOT NULL DEFAULT 'success',
  `fail_reason` VARCHAR(255) NOT NULL DEFAULT '',
  `ip`          VARCHAR(64)  NOT NULL DEFAULT '',
  `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_oplog_created` (`created_at`),
  KEY `idx_oplog_action`  (`action`, `created_at`),
  KEY `idx_oplog_openid`  (`openid`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='操作日志';

-- -----------------------------------------------------
-- 13. settings 系统配置（单行表，id 固定为 1）
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `settings` (
  `id`                    TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `company_name`          VARCHAR(128) NOT NULL DEFAULT '胜龙',
  `warning_enabled`       TINYINT      NOT NULL DEFAULT 1,
  `warning_notify_boss`   TINYINT      NOT NULL DEFAULT 1,
  `backup_enabled`        TINYINT      NOT NULL DEFAULT 1,
  `boss_openids`          JSON         DEFAULT NULL,
  `order_no_prefix_out`   VARCHAR(8)   NOT NULL DEFAULT 'OUT',
  `order_no_prefix_in`    VARCHAR(8)   NOT NULL DEFAULT 'IN',
  `updated_at`            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='系统配置';

SET FOREIGN_KEY_CHECKS = 1;

-- =====================================================
-- 说明：单据明细未加外键约束，由应用层保证一致性。
-- 原因：进销存场景下删除/作废频繁，外键会阻碍数据维护，
--       且所有写操作都通过统一事务出口，一致性已由事务保证。
-- =====================================================
