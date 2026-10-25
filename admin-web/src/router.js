import { createRouter, createWebHashHistory } from 'vue-router'
import { api, session, setToken, onNeedLogin } from './api'

const COFFEE = ['owner', 'barista']
const BOOK = ['owner', 'book_manager']
const OWNER = ['owner']

// 菜单和路由放在一起，按角色显示
export const MENU = [
  { group: '', items: [{ path: '/dashboard', title: '每日汇总', roles: OWNER }] },
  {
    group: '咖啡',
    items: [
      { path: '/orders', title: '订单处理', roles: COFFEE },
      { path: '/products', title: '商品管理', roles: COFFEE },
      { path: '/categories', title: '分类管理', roles: COFFEE },
      { path: '/tables', title: '桌台和桌码', roles: COFFEE }
    ]
  },
  {
    group: '书籍',
    items: [
      { path: '/rentals', title: '借阅处理', roles: BOOK },
      { path: '/books', title: '书目管理', roles: BOOK },
      { path: '/rules', title: '计费规则', roles: BOOK }
    ]
  },
  {
    group: '会员',
    items: [
      { path: '/members', title: '会员储值', roles: COFFEE },
      { path: '/member-settings', title: '储值设置', roles: OWNER }
    ]
  },
  {
    group: '店铺',
    items: [
      { path: '/staff', title: '员工管理', roles: OWNER },
      { path: '/settings', title: '店铺设置', roles: OWNER },
      { path: '/notify', title: '消息通知', roles: OWNER },
      { path: '/banners', title: '首页轮播', roles: OWNER },
      { path: '/coupons', title: '代金券', roles: OWNER }
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
  '/member-settings': () => import('./views/MemberSettings.vue')
}

const routes = [{ path: '/login', component: () => import('./views/Login.vue'), meta: { public: true } }]
MENU.forEach((g) => g.items.forEach((item) => {
  routes.push({ path: item.path, component: views[item.path], meta: { title: item.title, roles: item.roles } })
}))
routes.push({ path: '/:any(.*)*', redirect: () => firstPage() })

export function allowed(item) {
  return !!session.staff && item.roles.indexOf(session.staff.role) !== -1
}

export function firstPage() {
  for (const g of MENU) {
    for (const item of g.items) if (allowed(item)) return item.path
  }
  return '/login'
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
  return true
})

router.afterEach((to) => {
  document.title = (to.meta.title ? to.meta.title + ' · ' : '') + '进山咖啡管理后台'
})

onNeedLogin(() => {
  if (router.currentRoute.value.path !== '/login') router.replace({ path: '/login', query: { expired: '1' } })
})

export default router
