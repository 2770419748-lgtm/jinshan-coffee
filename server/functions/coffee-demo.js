// 示例菜单：方便第一次试用，价格和商品都只是占位，导入后在后台改成店里的真实菜单
const CUP = { name: '杯型', options: [{ name: '中杯', price: 0 }, { name: '大杯', price: 300 }] }
const TEMP = { name: '温度', options: [{ name: '热', price: 0 }, { name: '冰', price: 0 }] }
const SUGAR = { name: '糖度', options: [{ name: '标准糖', price: 0 }, { name: '少糖', price: 0 }, { name: '无糖', price: 0 }] }

module.exports = [
  {
    category: '咖啡',
    products: [
      { name: '美式', price: 1800, specs: [CUP, TEMP] },
      { name: '拿铁', price: 2200, specs: [CUP, TEMP] },
      { name: '手冲', price: 3200, specs: [] }
    ]
  },
  {
    category: '非咖啡',
    products: [
      { name: '抹茶拿铁', price: 2400, specs: [CUP, TEMP, SUGAR] },
      { name: '柠檬茶', price: 1800, specs: [SUGAR] }
    ]
  },
  {
    category: '甜点',
    products: [
      { name: '芝士蛋糕', price: 2800, specs: [] }
    ]
  }
]
