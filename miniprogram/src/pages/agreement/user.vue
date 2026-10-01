<template>
  <view class="doc">
    <view class="doc-head">
      <text class="doc-title">用户服务协议</text>
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
    title: '一、协议的范围与接受',
    paras: [
      `本协议是你与 ${OPERATOR_NAME} 之间就使用「${APP_NAME}」小程序所订立的约定。`,
      `「${APP_NAME}」是本企业内部使用的物资出入库管理系统，用于记录和管理企业自有物资的入库、出库、库存盘点与库存账目。它不面向社会公众提供商品或服务，仅供本企业员工在授权范围内使用。`,
      '当你勾选同意并开始使用本小程序，即表示你已阅读、理解并同意本协议的全部内容。如果你不同意本协议或其中任何条款，请停止使用。'
    ]
  },
  {
    title: '二、账号与身份',
    paras: [
      '你的账号由系统管理员根据你的岗位与工作职责开通，并通过微信登录与你本人绑定。',
      '你应当使用本人真实身份使用本小程序，不得将账号交由他人使用、代他人操作，也不得以他人身份登录。',
      '账号所具备的权限（可以看到哪些仓库、可以提交或审核哪些单据）由管理员按岗位配置。你应当在被授予的权限范围内使用，不得尝试越权访问或操作。',
      '如果你的岗位或职责发生变动，请及时联系管理员调整权限；离职时应当主动告知管理员注销账号。'
    ]
  },
  {
    title: '三、使用规范',
    paras: [
      '你承诺在使用本小程序时遵守以下要求：',
      '（1）如实登记。你对物资出入库数据、数量、单价、供应商等信息的填写应当真实、准确、完整，与实际业务情况一致；\n（2）规范操作。你应当按照企业既定的业务流程提交、确认或审核单据，不得绕过流程、不得代签代审；\n（3）不得虚假录入。严禁虚构出入库记录、虚增虚减数量或金额、伪造他人操作；\n（4）妥善保管登录凭证。因你保管不善导致账号被他人使用的，相应后果由你承担。',
      '你理解并同意：本系统记录的是企业自有资产的账目，任何虚假记载都可能造成企业财产损失，也可能触犯法律法规。'
    ]
  },
  {
    title: '四、物资账目与操作留痕',
    paras: [
      '为保证账目可追溯，你在本小程序内的每一次提交、确认、驳回、改价、盘点操作，都会记录操作人、操作时间与操作内容。',
      '已生效的单据不会因为操作人离职或账号注销而被删除——这是企业账务连续性与审计的固有要求。账号注销后，历史单据中的操作人信息会被匿名化处理。',
      '系统会对库存数量与成本进行自动核算。如你发现账目与实际不符，应当通过盘点等正式流程发起更正，而不是直接修改数据。'
    ]
  },
  {
    title: '五、服务的提供与变更',
    paras: [
      '本小程序由我们自行开发并部署在企业自有服务器上，我们会在合理范围内保障其正常运行。',
      '由于系统维护、升级、服务器故障、网络中断或其他不可抗力，服务可能出现短暂中断。我们会尽力缩短中断时间。',
      '我们可能根据业务需要对功能进行调整、增加或下线。功能调整不影响你在调整前已经产生的操作记录。'
    ]
  },
  {
    title: '六、知识产权',
    paras: [
      `本小程序的程序代码、界面设计、文字内容等由 ${OPERATOR_NAME} 所有或经合法授权使用。`,
      '未经书面许可，你不得复制、传播、反向工程或以其他方式使用本小程序的程序与内容。你在使用过程中录入的业务数据归企业所有。'
    ]
  },
  {
    title: '七、责任说明',
    paras: [
      '你理解并同意：因你违反本协议、违反企业内部管理规定或法律法规而造成的损失，由你本人承担相应责任。',
      '对于因不可抗力、第三方服务（如网络运营商、微信平台）故障导致的服务中断或数据延迟，我们不承担超出法律规定的责任。',
      '如因我们的过错导致你的合法权益受损，我们将依法承担相应责任。'
    ]
  },
  {
    title: '八、协议的修改',
    paras: [
      '当本协议发生重大变更时，我们会通过小程序内公告等方式通知你，并在你再次使用时重新征求你的同意。',
      '你继续使用本小程序，即视为接受修改后的协议。'
    ]
  },
  {
    title: '九、如何联系我们',
    paras: [
      `如果你对本协议有任何疑问、意见或投诉，可以通过以下方式联系我们：\n运营者：${OPERATOR_NAME}\n联系邮箱：${CONTACT_EMAIL}\n联系电话：${CONTACT_PHONE}`
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
