#!/usr/bin/env node
// 抓页面自己发出的 XHR/fetch（url + 请求体 + 响应），用来逆向接口参数。
//
// 何时用：抖音来客改了接口结构、或你要支持一个新的筛选项/新字段，而 references/api-map.md
// 里还没有这个参数。做法是先跑本脚本，再在页面上手动点一次那个按钮，请求体就露出来了 ——
// ui 点出来的请求体是唯一可信的口径来源，靠猜 JSON schema 试错成本极高。
//
// usage:
//   node capture-xhr.mjs <targetId> [reload|noreload] [seconds] [urlFilterRegex] [outFile]
//   默认: noreload 20 talent_square
const BASE = process.env.CDP_BASE || 'http://127.0.0.1:9222';

// 注入到页面里的钩子：包住 XMLHttpRequest 与 fetch，把命中过滤器的调用记到 window.__cap
const HOOK = `(function(){
  if (window.__cap) return;
  window.__cap = [];
  function rec(o){ try { window.__cap.push(o); if (window.__cap.length > 500) window.__cap.shift(); } catch(e){} }
  var FLT = __FILTER__;
  var oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m,u){ this.__m = m; this.__u = u; return oOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(b){
    var self = this, u = String(self.__u || '');
    if (FLT.test(u)) {
      self.addEventListener('load', function(){
        rec({ k:'xhr', m:self.__m, u:u, body:(typeof b === 'string' ? b : '(nonstring)'), status:self.status, resp:String(self.responseText||'').slice(0,200000) });
      });
    }
    return oSend.apply(this, arguments);
  };
  var of = window.fetch;
  window.fetch = function(input, init){
    var u = (typeof input === 'string') ? input : (input && input.url) || '';
    var pr = of.apply(this, arguments);
    if (FLT.test(u)) {
      try { pr.then(function(r){ r.clone().text().then(function(t){
        rec({ k:'fetch', u:u, body:(init && init.body) ? String(init.body) : '', status:r.status, resp:String(t).slice(0,200000) });
      }).catch(function(){}); }).catch(function(){}); } catch(e){}
    }
    return pr;
  };
})();`;

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', () => rej(new Error('websocket error')));
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
    }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ws, send };
}

async function main() {
  const [targetId, mode = 'noreload', secs = '20', filter = 'talent_square'] = process.argv.slice(2);
  const outFile = process.argv[7];
  const fs = await import('node:fs/promises');
  const list = await (await fetch(BASE + '/json/list')).json();
  const t = list.find((x) => x.id === targetId);
  if (!t) throw new Error('target not found: ' + targetId);
  const { ws, send } = await connect(t.webSocketDebuggerUrl);
  const re = new RegExp(filter, 'i');
  const hook = HOOK.replace('__FILTER__', '/' + filter.replace(/\\/g, '\\\\').replace(/\//g, '\\/') + '/i');
  const sent = [];

  // 监听必须在 reload 之前挂上，否则会漏掉页面加载时自己的请求
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.method === 'Network.requestWillBeSent') {
      const r = m.params.request;
      if (re.test(r.url)) {
        sent.push({ url: r.url, method: r.method, headers: r.headers, postData: r.postData ? String(r.postData).slice(0, 6000) : null, type: m.params.type });
      }
    }
  });

  try {
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Network.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: hook });

    if (mode === 'reload') await send('Page.reload', { ignoreCache: false });
    else await send('Runtime.evaluate', { expression: hook, returnByValue: true });

    const deadline = Date.now() + Math.max(3, parseInt(secs, 10)) * 1000;
    let tick = 0;
    while (Date.now() < deadline) {
      tick++;
      // 窗口被遮挡时渲染进程会冻结，页面自己的 JS（含 XHR）就不会跑，所以窗口期内持续唤醒
      try { await send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
      try { await send('Page.setWebLifecycleState', { state: 'active' }); } catch (e) {}
      if (tick === 2) { try { await send('Runtime.evaluate', { expression: hook, returnByValue: true }); } catch (e) {} }
      await new Promise((r) => setTimeout(r, 500));
    }

    const cap = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__cap || [])', returnByValue: true });
    const out = {
      target: { id: t.id, url: t.url },
      cdpRequests: sent,
      pageCapture: JSON.parse(cap.result?.value || '[]'),
    };
    const text = JSON.stringify(out, null, 1);
    if (outFile) { await fs.writeFile(outFile, text, 'utf8'); console.log('written ' + outFile); }
    else console.log(text);
  } finally {
    ws.close();
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
