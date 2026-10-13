/** 探针接收端：小程序里的探针把事件 POST 到 127.0.0.1:8901/probe，落盘到 probe-log.jsonl */
const http = require('http')
const fs = require('fs')
const LOG = require('path').join(__dirname, 'probe-log.jsonl')

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
  if (req.method === 'POST' && req.url === '/probe') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), body }) + '\n')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
    return
  }
  res.writeHead(404); res.end()
}).listen(8901, '127.0.0.1', () => console.log('probe receiver on 8901, log →', LOG))
