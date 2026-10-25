// 美团 / 抖音团购核销（走聚合核销接口的「服务零售」路由，和咖啡的餐饮路由分开）：现在只留接口，还没开通。
//
// 开通前要做的（店里和服务商那边）：
//   1. 店里在美团、抖音上架洗车团购套餐，店主本人用管店账号在平台页面确认商户授权；
//   2. 选好聚合核销服务商，拿到接口 Key，填在服务器配置文件里（不进代码仓库、不进前端）；
//   3. 拉一遍团购列表，把每个套餐 ID 对应到店里的服务项目或次卡次数（对照表），人工核一遍。
//
// 接上以后的流程（provider 是服务商的适配层，platform：1 美团、2 抖音）：
//   prepare({ platform, code })  预核销：只校验券有效、适用本店，不扣券；抖音每次都要重新拿 verify_token 和加密券码，不能传明文券码
//   verify({ platform, prepared }) 确认核销：把预核销返回的凭证原样传回去，拿到撤销凭证
//   cancel({ platform, record })  撤销（抖音 1 小时内）
// 本地记账表 cw_redeems：券码唯一 + 状态（prepared → verified → cancelled），连点两次只核销一次；
// 核销流水和撤销凭证至少留到对账周期结束；每天对账一次，发现授权失效及时提醒。金额单位是分。
const { BizError } = require('./base')

const PLATFORMS = { 1: '美团', 2: '抖音' }

function disabled() {
  return new BizError('美团、抖音团购核销还没开通', 'REDEEM_DISABLED')
}

// 接上服务商以前，预核销、核销、撤销都直接回「还没开通」
function createHandlers({ requireStaff }) {
  const notYet = async (event, openid) => {
    await requireStaff(openid)
    throw disabled()
  }
  return {
    async redeemStatus(event, openid) {
      await requireStaff(openid)
      return { enabled: false, platforms: PLATFORMS }
    },
    redeemPrepare: notYet,
    redeemVerify: notYet,
    redeemCancel: notYet
  }
}

module.exports = { PLATFORMS, createHandlers }
