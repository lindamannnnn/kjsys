/**
 * 本机探针接收服务：承接小程序里注入的诊断探针回传的数据。
 * 用法：node scripts/_mp-probe-server.js
 * 落盘：.tmp-local-audit/mp-probe.log
 */
const http = require('http')
const fs = require('fs')
const path = require('path')

const PORT = Number(process.env.PROBE_PORT || 8901)
const OUT = path.resolve(__dirname, '../.tmp-local-audit/mp-probe.log')

fs.mkdirSync(path.dirname(OUT), { recursive: true })

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS'
    })
    return res.end()
  }
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    let line
    try {
      const j = JSON.parse(body || '{}')
      line = `[${new Date().toISOString().slice(11, 23)}] ${j.t}${j.p ? ' :: ' + j.p : ''}`
    } catch (e) {
      line = `[raw] ${body.slice(0, 800)}`
    }
    fs.appendFileSync(OUT, line + '\n')
    console.log(line)
    res.writeHead(200, { 'content-type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end('{"code":0}')
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`probe server listening on http://127.0.0.1:${PORT}`)
  console.log(`writing to ${OUT}`)
})
