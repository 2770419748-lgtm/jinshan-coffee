// 示例规则和书目：方便第一次试用，导入后在后台改成店里真实的书和价格
module.exports = {
  rules: [
    { name: '按小时', type: 'hourly', price: 800, minHours: 1, maxHours: 8, graceMinutes: 10, desc: '先选几个小时，超时按小时补' },
    { name: '包天送咖啡', type: 'day', price: 3900, freeCups: 1, freeProducts: [], freeMaxFee: 2500, desc: '当天随便看，送一杯饮品' }
  ],
  books: [
    { title: '小王子', author: '圣埃克苏佩里', category: '文学', copies: 2 },
    { title: '瓦尔登湖', author: '梭罗', category: '文学', copies: 1 },
    { title: '人间词话', author: '王国维', category: '国学', copies: 1 }
  ]
}
