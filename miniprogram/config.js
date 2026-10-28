module.exports = {
  // 正式服务器：正式发布的版本连这里。域名备案、配好 HTTPS 以后改成 https://pigkun.com（末尾不要斜杠）
  apiBase: 'http://139.155.154.80:3000',
  // 测试服务器：开发者工具和体验版连这里，数据和正式版分开（见 utils/server.js）。备案后改成 https://test.pigkun.com；
  // 留空就都连正式服务器。还没备案时在开发者工具「详情 → 本地设置」里勾上「不校验合法域名」，体验版要打开「开发调试」
  testApiBase: 'http://139.155.154.80:3001',
  shopName: '进山咖啡',
  // 电脑网页后台的网址，不填就是 服务器地址/admin/，员工在小程序里能复制
  webAdminUrl: ''
}
