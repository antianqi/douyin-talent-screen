#!/usr/bin/env node
// 通过 CDP 发真实输入事件（零依赖）。
//
// 只在「接口参数未知、需要驱动 UI 抓真实请求」或「页面结构探查」时使用。
// 正常取数走 talent-query.js 的接口调用，不要靠点页面。
//
// usage:
//   node act.mjs wake    <targetId>
//   node act.mjs info    <targetId> <cssSelector>
//   node act.mjs click   <targetId> <cssSelector> [waitMs]
//   node act.mjs clickxy <targetId> <x> <y> [waitMs]
//   node act.mjs type    <targetId> <text>
//   node act.mjs key     <targetId> <Enter|Tab|Escape> [waitMs]
//   node act.mjs shot    <targetId> <out.png>
//   node act.mjs js      <targetId> <singleLineExpression>
//
// click / clickxy 用的是 Input.dispatchMouseEvent（真实鼠标），不是合成 DOM 事件，
// 因为 byted-design 的下拉/单选框对合成 click 反应不稳定。
const BASE = process.env.CDP_BASE || 'http://127.0.0.1:9222';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const list = await (await fetch(BASE + '/json/list')).json();
  const t = list.find((x) => x.id === rest[0]);
  if (!t) throw new Error('target not found: ' + rest[0]);
  const { ws, send } = await connect(t.webSocketDebuggerUrl);

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result ? r.result.value : undefined;
  };

  const clickAt = async (x, y, waitMs) => {
    const hit = await evaluate(`(function(){var e=document.elementFromPoint(${x},${y});return e?e.tagName+'|'+String(e.className).slice(0,70)+'|'+(e.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40):'none'})()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(waitMs);
    // elementFromPoint 的命中结果要回报：命中错了说明坐标被浮层挡了或页面滚了
    console.log(`clicked(${x},${y}) hit=${hit}`);
  };

  try {
    await send('Runtime.enable');
    try { await send('Page.enable'); } catch (e) {}

    switch (cmd) {
      case 'wake': {
        try { await send('Page.bringToFront'); } catch (e) {}
        try { await send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
        try { await send('Page.setWebLifecycleState', { state: 'active' }); } catch (e) {}
        console.log(await evaluate('JSON.stringify({vis:document.visibilityState,focus:document.hasFocus()})'));
        break;
      }
      case 'js':
        console.log(JSON.stringify(await evaluate(rest[1]), null, 1));
        break;
      case 'info': {
        const js = `(function(){var el=document.querySelector(${JSON.stringify(rest[1])});if(!el)return JSON.stringify({found:false});var r=el.getBoundingClientRect();return JSON.stringify({found:true,tag:el.tagName,cls:String(el.className).slice(0,150),rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},vis:r.width>0&&r.height>0,html:String(el.outerHTML).replace(/\\s+/g,' ').slice(0,300)})})()`;
        console.log(await evaluate(js));
        break;
      }
      case 'click': {
        const js = `(function(){var el=document.querySelector(${JSON.stringify(rest[1])});if(!el)return JSON.stringify({found:false});el.scrollIntoView({block:'center',inline:'center'});var r=el.getBoundingClientRect();return JSON.stringify({found:true,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width),h:Math.round(r.height)})})()`;
        const v = JSON.parse(await evaluate(js));
        if (!v.found) { console.error('selector not found: ' + rest[1]); process.exit(3); }
        if (v.w === 0 || v.h === 0) { console.error('element not visible: ' + JSON.stringify(v)); process.exit(4); }
        await clickAt(v.x, v.y, parseInt(rest[2] || '900', 10));
        break;
      }
      case 'clickxy':
        await clickAt(parseFloat(rest[1]), parseFloat(rest[2]), parseInt(rest[3] || '900', 10));
        break;
      case 'type':
        await send('Input.insertText', { text: rest[1] });
        await sleep(400);
        console.log('typed len=' + rest[1].length);
        break;
      case 'key': {
        const KEYS = { Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Tab: { code: 'Tab', keyCode: 9 }, Escape: { code: 'Escape', keyCode: 27 } };
        const k = KEYS[rest[1]] || { code: rest[1], keyCode: 0 };
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: rest[1], code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, text: k.text || '' });
        await sleep(40);
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: rest[1], code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode });
        await sleep(parseInt(rest[2] || '900', 10));
        console.log('key ' + rest[1]);
        break;
      }
      case 'shot': {
        const fs = await import('node:fs/promises');
        const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        await fs.writeFile(rest[1], Buffer.from(r.data, 'base64'));
        console.log('wrote ' + rest[1]);
        break;
      }
      default:
        console.error('usage: act.mjs wake|info|click|clickxy|type|key|shot|js <targetId> ...');
        process.exit(2);
    }
  } finally {
    ws.close();
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
