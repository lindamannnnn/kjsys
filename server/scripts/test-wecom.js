/**
 * 企业微信推送 · 一键自测（投产用）
 * ------------------------------------------------------------
 * 用途：在生产 .env 里填好 WECOM_CORPID / WECOM_AGENTID / WECOM_SECRET 之后，
 *   跑这个脚本验证「能不能真的把消息推到企业微信」。
 *
 * 用法：
 *   node scripts/test-wecom.js <企微userid>
 *   例：node scripts/test-wecom.js ZhangSan
 *
 * 它会：检查配置 → 拿 access_token → 给指定成员发一条测试文本。
 * 成功 = 那个人的企业微信立刻收到一条「胜龙进销存·推送测试」。
 */
require('../src/config/env')
const wecom = require('../src/services/wecom')

async function main() {
  const userid = process.argv[2]
  console.log('=== 企业微信推送自测 ===')
  console.log('配置检查：isEnabled =', wecom.isEnabled())
  if (!wecom.isEnabled()) {
    console.log('❌ 未配置齐。请在 .env 填 WECOM_CORPID / WECOM_AGENTID / WECOM_SECRET 三个。')
    process.exit(1)
  }
  if (!userid) {
    console.log('❌ 请传一个企微成员 UserID，例：node scripts/test-wecom.js ZhangSan')
    process.exit(1)
  }
  console.log('目标成员：', userid)
  const r = await wecom.sendText([userid], '【胜龙进销存】企业微信推送测试：如果你看到这条，说明推送通道已打通 ✅')
  if (r.sent > 0) {
    console.log('✅ 推送成功！请到企业微信查看是否收到。')
  } else {
    console.log('❌ 推送失败：', r.errmsg)
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => { console.error('异常：', e.message); process.exit(1) })
