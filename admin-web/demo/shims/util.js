module.exports = {
  promisify: (fn) => (...args) => new Promise((resolve, reject) => {
    fn(...args, (err, value) => (err ? reject(err) : resolve(value)))
  })
}
