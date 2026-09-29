// 格式化工具函数

/**
 * 格式化日期
 * @param {Date|string|number} date - 日期
 * @param {string} format - 格式（如 'YYYY-MM-DD HH:mm:ss'）
 * @returns {string}
 */
export function formatDate(date, format = 'YYYY-MM-DD HH:mm:ss') {
  if (!date) return ''
  const d = new Date(date)
  if (isNaN(d.getTime())) return ''

  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  const seconds = String(d.getSeconds()).padStart(2, '0')

  return format
    .replace('YYYY', year)
    .replace('MM', month)
    .replace('DD', day)
    .replace('HH', hours)
    .replace('mm', minutes)
    .replace('ss', seconds)
}

/**
 * 格式化金额
 * @param {number} amount - 金额
 * @param {number} decimals - 小数位数
 * @returns {string}
 */
export function formatMoney(amount, decimals = 2) {
  if (amount === null || amount === undefined) return '0.00'
  return Number(amount).toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * 格式化数量
 * @param {number} quantity - 数量
 * @returns {string}
 */
export function formatQuantity(quantity) {
  if (quantity === null || quantity === undefined) return '0'
  return Number(quantity).toLocaleString()
}

/**
 * 格式化日期为友好显示（今天/昨天/具体日期）
 * @param {Date|string|number} date - 日期
 * @returns {string}
 */
export function formatFriendlyDate(date) {
  if (!date) return ''
  const d = new Date(date)
  if (isNaN(d.getTime())) return ''

  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate())

  const diffTime = today.getTime() - target.getTime()
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '昨天'
  if (diffDays < 7) return `${diffDays}天前`

  return formatDate(date, 'YYYY-MM-DD')
}

/**
 * 格式化单据类型
 * @param {string} type - 类型代码
 * @param {string} orderType - 单据类型（outbound/inbound）
 * @returns {string}
 */
export function formatOrderType(type, orderType) {
  const outTypes = {
    'lingyong': '领用',
    'xiaoshou': '销售',
    'baofei': '报废',
    'zengpin': '赠品',
    'tiaozheng': '调整',
    'caigou_tuihuo': '采购退货'
  }
  const inTypes = {
    'caigou': '采购入库',
    'xiaoshou_tuihuo': '销售退货',
    'tiaozheng': '调整'
  }

  const types = orderType === 'outbound' ? outTypes : inTypes
  return types[type] || type
}
