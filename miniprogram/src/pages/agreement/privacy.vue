<template>
  <view class="doc">
    <view class="doc-head">
      <text class="doc-title">隐私政策</text>
      <text class="doc-meta">{{ APP_NAME }} · {{ DOC_VERSION }}</text>
      <text class="doc-meta">更新日期：{{ UPDATE_DATE }}　生效日期：{{ EFFECT_DATE }}</text>
    </view>

    <view v-for="(sec, i) in sections" :key="i" class="sec">
      <text class="sec-title">{{ sec.title }}</text>
      <text v-for="(p, j) in sec.paras" :key="j" class="sec-para">{{ p }}</text>
    </view>

    <view class="doc-foot">
      <text class="doc-foot-text">{{ OPERATOR_NAME }}</text>
      <text class="doc-foot-text">{{ CONTACT_EMAIL }}</text>
    </view>
  </view>
</template>

<script setup>
import {
  APP_NAME, OPERATOR_NAME, CONTACT_EMAIL, CONTACT_PHONE,
  DOC_VERSION, UPDATE_DATE, EFFECT_DATE
} from '@/utils/legal'

const sections = [
  {
    title: '引言',
    paras: [
      `「${APP_NAME}」是由 ${OPERATOR_NAME} 开发并提供给特定单位内部使用的物资出入库管理工具，仅面向该单位内部人员在授权范围内使用。我们深知个人信息对你的重要性，会以谨慎、负责的态度处理你使用本小程序过程中涉及的个人信息。请你在使用前仔细阅读并充分理解本政策。`
    ]
  },
  {
    title: '一、我们收集哪些信息',
    paras: [
      '为了向你提供内部物资管理服务，我们会在你使用本小程序的过程中收集以下信息：',
      '1. 微信用户标识（openid）\n你在本小程序内授权登录时，微信会向我们提供你在本小程序内的唯一标识 openid。我们用它来识别你的账号、绑定你在系统内的岗位角色与仓库权限。',
      '2. 真实姓名\n首次使用时，为确认你的身份、分配与你岗位相符的操作权限，我们会请你填写真实姓名。这是系统判断"谁能看哪个仓库、谁能审哪张单"的依据。',
      '3. 手机号\n首次使用时，为便于管理员核对你的身份、在必要时与你取得联系，我们会请你填写手机号。该手机号仅用于使用单位内部的身份核对与工作联系，不会用于其他用途。',
      '4. 你的操作记录\n你在本小程序内进行的每一次出入库提交、单据确认或驳回、盘点录入等操作，都会连同操作人和操作时间被记录下来。这是使用单位内部物资管理的固有要求——每一笔物资的流向都必须能够追溯到经手人。',
      '5. 登录与访问日志\n为保障系统安全、排查异常，我们会记录你登录和操作时的时间与网络地址（IP）。'
    ]
  },
  {
    title: '二、我们如何使用这些信息',
    paras: [
      '我们收集上述信息，仅用于以下目的：',
      '（1）识别你的身份，并分配与你岗位相符的操作权限；\n（2）记录物资出入库的经手人，使每一笔账目可追溯、可对账；\n（3）在使用单位内部进行必要的审批、核对与审计；\n（4）保障系统安全，排查异常登录与异常操作。',
      '我们不会将这些信息用于广告推送、用户画像、行为分析等与上述目的无关的用途。'
    ]
  },
  {
    title: '三、我们如何存储与保护',
    paras: [
      '本小程序不使用微信云开发存储你的信息。上述信息存储在使用单位自有的服务器上，服务器位于中国境内。',
      '我们通过访问权限控制、账号鉴权、操作留痕等措施保护你的信息安全。仅管理员与被授权人员在履行职责的必要范围内可以查看。'
    ]
  },
  {
    title: '四、我们如何对外提供',
    paras: [
      '我们不会向任何第三方出售、出租或以其他方式非法提供你的个人信息。以下情形除外：',
      '（1）你本人明确同意；\n（2）依据法律法规规定，或应司法机关、行政机关的强制性要求；\n（3）为维护公共利益或他人人身、财产安全所必需。'
    ]
  },
  {
    title: '五、信息的保留与删除',
    paras: [
      '在你与该使用单位保持劳动关系或使用关系期间，我们会保留上述信息。',
      '当你离职或不再需要使用本小程序时，可以联系管理员注销账号。注销后，你的账号信息（姓名、手机号、登录凭证）将被删除或匿名化处理。',
      '需要特别说明的是：为保证历史物资账目的完整性（这是账务审计的固有要求），你此前提交并已生效的单据记录会继续保留，但会以"操作人已注销"的方式呈现，不再关联你的个人信息。'
    ]
  },
  {
    title: '六、你的权利',
    paras: [
      '（1）查询与更正：你可以在「我的」页面查看并更正你的姓名、手机号；\n（2）删除与注销：你可以通过下方联系方式申请注销账号；\n（3）撤回同意：你可以随时停止使用本小程序。撤回同意不影响撤回前基于你的同意已经进行的处理。',
      `如需行使上述权利，请通过本政策末尾的联系方式与我们联系，我们将在 15 个工作日内处理你的请求。`
    ]
  },
  {
    title: '七、关于未成年人',
    paras: [
      '本小程序面向使用单位内部人员提供，不面向未成年人。我们不会主动收集未成年人的个人信息。'
    ]
  },
  {
    title: '八、本政策的更新',
    paras: [
      '当本政策发生重大变更时，我们会通过小程序内公告等方式通知你，并在你再次使用时重新征求你的同意。'
    ]
  },
  {
    title: '九、如何联系我们',
    paras: [
      `如果你对本政策有任何疑问、意见或投诉，可以通过以下方式联系我们：\n开发者：${OPERATOR_NAME}\n联系邮箱：${CONTACT_EMAIL}\n联系电话：${CONTACT_PHONE}`
    ]
  }
]
</script>

<style lang="scss" scoped>
.doc {
  min-height: 100vh;
  padding: 40rpx 40rpx 80rpx;
  background: #f5f5f5;
  box-sizing: border-box;
}

.doc-head {
  padding: 20rpx 0 40rpx;

  .doc-title {
    font-size: 44rpx;
    font-weight: bold;
    color: #1a1a2e;
    display: block;
    margin-bottom: 16rpx;
  }

  .doc-meta {
    font-size: 24rpx;
    color: #999;
    display: block;
    line-height: 1.6;
  }
}

.sec {
  background: #fff;
  border-radius: 16rpx;
  padding: 32rpx;
  margin-bottom: 24rpx;

  .sec-title {
    font-size: 30rpx;
    font-weight: bold;
    color: #1a1a2e;
    display: block;
    margin-bottom: 20rpx;
  }

  .sec-para {
    font-size: 27rpx;
    color: #444;
    line-height: 1.8;
    display: block;
    margin-bottom: 16rpx;

    &:last-child {
      margin-bottom: 0;
    }
  }
}

.doc-foot {
  text-align: center;
  padding: 20rpx 0 40rpx;

  .doc-foot-text {
    font-size: 24rpx;
    color: #999;
    display: block;
    line-height: 1.8;
  }
}
</style>
