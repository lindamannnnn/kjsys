/**
 * 真机诊断探针（只注入页面文件）。
 *
 * 为什么只注入 pages/index/index.js：
 *   实测发现工具把 app.js / vendor 从「主包 bundle 缓存」里出，页面文件走
 *   appservice-hotreload 通道 —— 注入 app.js 的探针在真机上根本不会执行，
 *   只有页面文件里的探针能跑起来。
 *
 * 为什么不引用压缩后的变量名：包装 wx.createPage 拿 options，稳。
 *
 *   node scripts/_inject-mp-probe.js            注入（会先还原上一次）
 *   node scripts/_inject-mp-probe.js --revert   还原并清理 .orig 备份
 *
 * 验证点：
 *   1) setup 是否还抛错（白屏的直接原因）
 *   2) 渲染数据是否真的到页面了（读页面 data）
 *   3) 钩子有没有注册成功：直接读 vm.$['onShow'] 数组长度
 *   4) 框架后续调用生命周期时到底调了哪些名字：给 vm.$callHook 装监视器
 * 回传：http://127.0.0.1:8901/p
 */
const fs = require('fs')
const path = require('path')

const DIST = path.resolve(__dirname, '../miniprogram/dist/build/mp-weixin')
const INDEX = path.join(DIST, 'pages/index/index.js')
const MARK = '/*__MP_PROBE__*/'
const EP = 'http://127.0.0.1:8901/p'

const PAGE_PROBE = `
;(function(){
  var EP = '${EP}';
  var REQ = 0, HOOKLOG = [];
  function P(tag, payload){
    try {
      wx.request({ url: EP, method: 'POST', header: { 'content-type': 'application/json' },
        data: { t: tag, p: String(payload === undefined ? '' : payload).slice(0, 1500), ts: Date.now() } });
    } catch (e) {}
  }
  P('boot', 'page probe installed');
  try { if (wx.onError) wx.onError(function(m){ P('wx.onError', m); }); } catch (e) {}
  try { if (wx.onUnhandledRejection) wx.onUnhandledRejection(function(r){
    P('wx.onUnhandledRejection', (r && r.reason && (r.reason.stack || r.reason.message)) || String(r && r.reason));
  }); } catch (e) {}

  /* 统计业务请求（排除探针自己的回传）；vendor 若在初始化时捕获了 wx.request，这项就只是旁证 */
  try {
    var _req = wx.request;
    wx.request = function (o) {
      try {
        var u2 = (o && o.url) || '';
        if (u2.indexOf('127.0.0.1:8901') === -1) { REQ++; }
      } catch (e) {}
      return _req.apply(this, arguments);
    };
  } catch (e) { P('wrap-request-error', String(e)); }

  /* 页面栈自检：钩子注册结果 + 渲染数据 + 装上 $callHook 监视器 */
  function pageDiag(tag){
    try {
      var ps = getCurrentPages();
      var pg = ps[ps.length - 1] || null;
      if (!pg) { P(tag, '页面栈为空'); return; }
      var vm = pg.$vm;
      var s = '页面栈=' + ps.length + ' | route=' + (pg.route || '?') + ' | $vm=' + (vm ? 'yes' : 'no');
      if (vm) {
        s += ' | typeof $callHook=' + typeof vm.$callHook;
        if (vm.$ && typeof vm.$ === 'object') {
          var a = vm.$['onShow'];
          s += ' | vm.$["onShow"]=' + (Array.isArray(a) ? ('数组 len=' + a.length) : ('非数组 ' + typeof a));
          if (Array.isArray(a)) {
            s += ' | 成员=' + a.map(function (f) { return (f && f.name) || '(匿名)' }).join('/');
          }
        } else { s += ' | vm.$ 缺失(' + typeof vm.$ + ')'; }
      }
      s += ' | 业务请求累计=' + REQ;
      P(tag, s);
      try { P(tag + '-DATA', 'data=' + JSON.stringify(pg.data).slice(0, 900)); } catch (e) {}

      if (vm && !vm.__probeCH && typeof vm.$callHook === 'function') {
        vm.__probeCH = 1;
        var _ch = vm.$callHook;
        vm.$callHook = function (name) {
          HOOKLOG.push(name);
          try {
            var arr = (this.$ && this.$[name]) || null;
            P('CALLHOOK', name + ' | 该钩子回调数=' + (arr ? arr.length : 0) + ' | 业务请求累计=' + REQ);
          } catch (e) {}
          return _ch.apply(this, arguments);
        };
        P('callHook-monitor', 'installed');
      }
    } catch (e) { P(tag + '-error', (e && e.stack) || String(e)); }
  }
  setTimeout(function(){ pageDiag('T1500'); }, 1500);
  setTimeout(function(){
    P('T7000-hooklog', '期间被调用的生命周期=' + (HOOKLOG.join(' > ') || '(无)') + ' | 业务请求累计=' + REQ);
    pageDiag('T7000');
  }, 7000);
  setTimeout(function(){
    P('T15000-hooklog', '期间被调用的生命周期=' + (HOOKLOG.join(' > ') || '(无)') + ' | 业务请求累计=' + REQ);
  }, 15000);

  /* 包装 wx.createPage：拿到 options，包 setup 抓异常；名字与压缩无关 */
  try {
    var _createPage = wx.createPage;
    if (typeof _createPage === 'function') {
      wx.createPage = function (options) {
        try {
          P('CREATE-PAGE', 'options keys=' + Object.keys(options || {}).join(',') +
            ' | typeof setup=' + typeof (options && options.setup));
          var _setup = options && options.setup;
          if (typeof _setup === 'function') {
            options.setup = function () {
              try {
                var r = _setup.apply(this, arguments);
                P('INDEX-SETUP-OK', 'typeof returned=' + typeof r);
                if (typeof r === 'function') {
                  var _render = r;
                  return function () {
                    try {
                      var vnode = _render.apply(this, arguments);
                      P('INDEX-RENDER-OK', 'vnode=' + (vnode ? 'yes' : 'no'));
                      return vnode;
                    } catch (e) { P('INDEX-RENDER-ERROR', (e && e.stack) || String(e)); throw e; }
                  };
                }
                return r;
              } catch (e) { P('INDEX-SETUP-ERROR', (e && e.stack) || String(e)); throw e; }
            };
            P('INDEX-SETUP-WRAPPED', 'ok');
          }
        } catch (e) { P('CREATE-PAGE-WRAP-ERROR', (e && e.stack) || String(e)); }
        return _createPage.apply(this, arguments);
      };
      P('createPage-wrapped', 'ok');
    } else {
      P('createPage-wrapped', 'wx.createPage 不是函数：' + typeof _createPage);
    }
  } catch (e) { P('createPage-wrap-error', (e && e.stack) || String(e)); }
})();
`

function inject() {
  if (!fs.existsSync(INDEX)) { console.log('页面产物不存在：' + INDEX); process.exit(1) }
  const src = fs.readFileSync(INDEX, 'utf8')
  if (src.indexOf(MARK) > -1) { console.log('已注入过，跳过（先跑 --revert）'); return }
  fs.writeFileSync(INDEX + '.orig', src)
  const i = src.lastIndexOf('wx.createPage')
  const out = i > -1 ? src.slice(0, i) + MARK + PAGE_PROBE + src.slice(i) : src + MARK + PAGE_PROBE
  fs.writeFileSync(INDEX, out)
  console.log('已注入 → pages/index/index.js')
}

function revert() {
  // 保险：只有「当前文件确实被注入过」时才用备份还原，
  // 否则一份过期的 .orig 会把刚编译好的新产物静默回退成旧代码（踩过一次）
  const cur = fs.existsSync(INDEX) ? fs.readFileSync(INDEX, 'utf8') : ''
  const curIsInjected = cur.indexOf(MARK) > -1
  if (fs.existsSync(INDEX + '.orig')) {
    if (curIsInjected) {
      fs.copyFileSync(INDEX + '.orig', INDEX)
      console.log('已还原 pages/index/index.js')
    } else {
      console.log('检测到已过期的 .orig 备份，直接删除（当前文件不是注入态，不能用它还原）')
    }
    fs.unlinkSync(INDEX + '.orig')
  }
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      if (fs.statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.orig')) { fs.unlinkSync(p); console.log('清理残留 ' + path.relative(DIST, p)) }
    }
  }
  walk(DIST)
}

if (process.argv[2] === '--revert') revert()
else { revert(); inject() }
