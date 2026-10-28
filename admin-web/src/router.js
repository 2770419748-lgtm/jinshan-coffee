import { reactive } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import { api, session, setToken, onNeedLogin, config } from './api'

const COFFEE = ['owner', 'barista']
const BOOK = ['owner', 'book_manager']
const OWNER = ['owner']
const CW_ADMIN = ['owner', 'carwash_manager']
const CW_STAFF = ['owner', 'carwash_manager', 'technician']

// 两家店共用一个后台，顶上切换；店主两家都能进，其他员工只看得到自己那家
export const SHOPS = [
  { key: 'coffee', name: config().shopName || '进山咖啡', short: '咖啡' },
  { key: 'carwash', name: config().carwashName || '黑镜车体护理车房', short: '洗车' }
]
const SHOP_KEY = 'jinshan_shop'

export const current = reactive({ shop: readShop() })

function readShop() {
  try {
    return localStorage.getItem(SHOP_KEY) === 'carwash' ? 'carwash' : 'coffee'
  } catch (e) {
    return 'coffee'
  }
}

function setShop(key) {
  current.shop = key
  try {
    localStorage.setItem(SHOP_KEY, key)
  } catch (e) {
    // 浏览器禁用了本地存储时只在当前页面有效
  }
}

// 菜单和路由放在一起，按店和角色显示
export const MENU = [
  { shop: 'coffee', group: '', items: [{ path: '/dashboard', title: '每日汇总', roles: OWNER }] },
  {
    shop: 'coffee',
    group: '咖啡',
    items: [
      { path: '/orders', title: '订单处理', roles: COFFEE },
      { path: '/products', title: '商品管理', roles: COFFEE },
      { path: '/categories', title: '分类管理', roles: COFFEE },
      { path: '/tables', title: '桌台和桌码', roles: COFFEE }
    ]
  },
  {
    shop: 'coffee',
    group: '书籍',
    items: [
      { path: '/rentals', title: '借阅处理', roles: BOOK },
      { path: '/books', title: '书目管理', roles: BOOK },
      { path: '/rules', title: '计费规则', roles: BOOK }
    ]
  },
  {
    shop: 'coffee',
    group: '会员',
    items: [
      { path: '/members', title: '会员储值', roles: COFFEE },
      { path: '/member-settings', title: '储值设置', roles: OWNER },
      { path: '/star-settings', title: '集星设置', roles: OWNER }
    ]
  },
  {
    shop: 'coffee',
    group: '店铺',
    items: [
      { path: '/staff', title: '员工管理', roles: OWNER },
      { path: '/settings', title: '店铺设置', roles: OWNER },
      { path: '/notify', title: '消息通知', roles: OWNER },
      { path: '/banners', title: '首页轮播', roles: OWNER },
      { path: '/coupons', title: '代金券', roles: OWNER }
    ]
  },
  { shop: 'carwash', group: '', items: [{ path: '/cw/dashboard', title: '洗车汇总', roles: CW_ADMIN }] },
  {
    shop: 'carwash',
    group: '预约',
    items: [
      { path: '/cw/orders', title: '预约订单', roles: CW_ADMIN },
      { path: '/cw/services', title: '服务项目', roles: CW_ADMIN }
    ]
  },
  {
    shop: 'carwash',
    group: '会员',
    items: [
      { path: '/cw/counter', title: '到店收银', roles: CW_STAFF },
      { path: '/cw/members', title: '会员管理', roles: CW_ADMIN },
      { path: '/cw/member-settings', title: '储值和次卡', roles: CW_ADMIN },
      { path: '/cw/links', title: '送咖啡券', roles: CW_ADMIN }
    ]
  },
  {
    shop: 'carwash',
    group: '店铺',
    items: [
      { path: '/cw/techs', title: '技师管理', roles: CW_ADMIN },
      { path: '/cw/settings', title: '洗车店设置', roles: CW_ADMIN }
    ]
  }
]

const views = {
  '/dashboard': () => import('./views/Dashboard.vue'),
  '/orders': () => import('./views/Orders.vue'),
  '/products': () => import('./views/Products.vue'),
  '/categories': () => import('./views/Categories.vue'),
  '/tables': () => import('./views/Tables.vue'),
  '/rentals': () => import('./views/Rentals.vue'),
  '/books': () => import('./views/Books.vue'),
  '/rules': () => import('./views/Rules.vue'),
  '/staff': () => import('./views/Staff.vue'),
  '/settings': () => import('./views/Settings.vue'),
  '/notify': () => import('./views/Notify.vue'),
  '/banners': () => import('./views/Banners.vue'),
  '/coupons': () => import('./views/Coupons.vue'),
  '/members': () => import('./views/Members.vue'),
  '/member-settings': () => import('./views/MemberSettings.vue'),
  '/star-settings': () => import('./views/StarSettings.vue'),
  '/cw/dashboard': () => import('./views/CarwashDashboard.vue'),
  '/cw/orders': () => import('./views/CarwashOrders.vue'),
  '/cw/services': () => import('./views/CarwashServices.vue'),
  '/cw/counter': () => import('./views/CarwashCounter.vue'),
  '/cw/members': () => import('./views/CarwashMembers.vue'),
  '/cw/member-settings': () => import('./views/CarwashMemberSettings.vue'),
  '/cw/links': () => import('./views/CarwashLinks.vue'),
  '/cw/techs': () => import('./views/CarwashTechs.vue'),
  '/cw/settings': () => import('./views/CarwashSettings.vue')
}

const routes = [{ path: '/login', component: () => import('./views/Login.vue'), meta: { public: true } }]
MENU.forEach((g) => g.items.forEach((item) => {
  routes.push({ path: item.path, component: views[item.path], meta: { title: item.title, roles: item.roles, shop: g.shop } })
}))
routes.push({ path: '/:any(.*)*', redirect: () => firstPage() })

export function allowed(item) {
  return !!session.staff && item.roles.indexOf(session.staff.role) !== -1
}

// 这位员工能进哪几家店
export function myShops() {
  return SHOPS.filter((s) => MENU.some((g) => g.shop === s.key && g.items.some(allowed)))
}

// 先找当前这家店能进的第一页，没有再找另一家
export function firstPage(shop) {
  const want = shop || current.shop
  const groups = MENU.filter((g) => g.shop === want).concat(MENU.filter((g) => g.shop !== want))
  for (const g of groups) {
    for (const item of g.items) if (allowed(item)) return item.path
  }
  return '/login'
}

export function shopOf(key) {
  return SHOPS.find((s) => s.key === key) || SHOPS[0]
}

const router = createRouter({ history: createWebHashHistory(), routes })

// 打开网页时用保存的 token 换回员工身份
async function loadStaff() {
  if (session.staff || !session.token) return session.staff
  try {
    const me = await api.common('login')
    session.staff = me.staff
    if (!me.staff) setToken('')
  } catch (e) {
    if (e.code !== 'NEED_LOGIN') throw e
  }
  return session.staff
}

router.beforeEach(async (to) => {
  if (to.meta.public) return true
  let staff = null
  try {
    staff = await loadStaff()
  } catch (e) {
    // 网络问题：留在登录页提示
    return { path: '/login', query: { error: e.message } }
  }
  if (!staff) return { path: '/login', query: { next: to.fullPath } }
  if (to.meta.roles && to.meta.roles.indexOf(staff.role) === -1) {
    const first = firstPage()
    return first === to.path ? true : first
  }
  if (to.meta.shop && to.meta.shop !== current.shop) setShop(to.meta.shop)
  return true
})

router.afterEach((to) => {
  const shop = shopOf(to.meta.shop || current.shop)
  document.title = (to.meta.title ? to.meta.title + ' · ' : '') + shop.name + '管理后台'
})

onNeedLogin(() => {
  if (router.currentRoute.value.path !== '/login') router.replace({ path: '/login', query: { expired: '1' } })
})

export default router
