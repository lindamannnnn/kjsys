# -*- coding: utf-8 -*-
"""向打包产物注入探针（只注入页面文件；还原必须先确认文件含探针标记）"""
import io, os, sys

import sys as _s
PAGE = _s.argv[2] if len(_s.argv) > 2 else r'G:/sl/shenglong-erp/miniprogram/dist/build/mp-weixin/pages/storekeeper/pending.js'

MARK = '__SL_PROBE_8901__'
PROBE = """
;/*__SL_PROBE_8901__*/
;(function(){
  if (typeof wx === 'undefined' || !wx.request) return
  function P(tag, msg){
    try { wx.request({ url:'http://127.0.0.1:8901/probe', method:'POST',
      data:{ tag:String(tag), msg:String(msg).slice(0,300) } }) } catch(e){}
  }
  var _sm = wx.showModal
  wx.showModal = function(opt){
    P('showModal.show', (opt&&opt.title)||'')
    var s = opt && opt.success
    var f = opt && opt.fail
    var o = Object.assign({}, opt, {
      success: function(res){
        P('showModal.result', 'confirm=' + !!(res&&res.confirm) + ' cancel=' + !!(res&&res.cancel))
        if (s) return s(res)
      },
      fail: function(e){ P('showModal.fail', String(e&&e.errMsg||e)); if (f) return f(e) }
    })
    return _sm.call(this, o)
  }
  var _st = wx.showToast
  wx.showToast = function(opt){ P('showToast', (opt&&opt.title)||''); return _st.apply(this, arguments) }
  var _rq = wx.request
  wx.request = function(opt){
    var u = (opt && opt.url) || ''
    var isApi = u.indexOf('/api/') >= 0
    if (isApi && opt.data && opt.data.action) {
      P('api', u.split('/api/')[1] + '#' + opt.data.action)
    }
    if (isApi) {
      var s = opt.success
      var f0 = opt.fail
      var c0 = opt.complete
      opt.fail = function(res){ P('api.fail', u.split('/api/')[1] + ' err=' + String(res && res.errMsg || res).slice(0,120)); if (f0) return f0(res) }
      opt.complete = function(res){ P('api.complete', u.split('/api/')[1] + ' status=' + (res && res.statusCode)); if (c0) return c0(res) }
      opt = Object.assign({}, opt, { success: function(res){
        var b = res && res.data
        P('api.result', u.split('/api/')[1] + '#' + ((opt.data&&opt.data.action)||'') +
          ' code=' + (b && b.code) + ' sub=' + (b && b.data && b.data.subCategories ? b.data.subCategories.length : '-'))
        if (s) return s(res)
      }})
    }
    return _rq.apply(this, arguments)
  }
  P('probe-loaded', 'pending.js')
})();
"""

def inject():
    s = io.open(PAGE, encoding='utf-8').read()
    if MARK in s:
        print('已有探针，跳过')
        return
    if not os.path.exists(PAGE + '.orig'):
        io.open(PAGE + '.orig', 'w', encoding='utf-8').write(s)
    io.open(PAGE, 'w', encoding='utf-8').write(s + PROBE)
    print('探针已注入 pending.js（备份 .orig）')

def restore():
    if not os.path.exists(PAGE + '.orig'):
        print('没有 .orig 备份，无法还原')
        return
    cur = io.open(PAGE, encoding='utf-8').read()
    if MARK not in cur:
        print('当前文件不含探针标记，拒绝用旧备份覆盖（防回退新代码）')
        return
    io.open(PAGE, 'w', encoding='utf-8').write(io.open(PAGE + '.orig', encoding='utf-8').read())
    os.remove(PAGE + '.orig')
    print('已还原 pending.js')

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'restore':
        restore()
    else:
        inject()
