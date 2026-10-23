#!/usr/bin/env node
// 抖音来客 CDP 客户端（零依赖，Node 18+ 自带 fetch / WebSocket）。
//
// usage:
//   node cdp.mjs list
//   node cdp.mjs open <url>
//   node cdp.mjs close <targetId>
//   node cdp.mjs cookies <targetId> <url1,url2>
//   node cdp.mjs wake <targetId>
//   node cdp.mjs eval <targetId> <scriptFile>
//   node cdp.mjs evalp <targetId> <scriptFile> <argJsonOrFile>
//
// eval  : 同步求值，适合纯计算脚本。
// evalp : 先注入 window.__ARG 再求值，并 awaitPromise。参数可以是 JSON 字面量，
//         或一个 .json 文件路径（Windows 下推荐用文件，避免 PowerShell 引号问题）。
//
// 同目录 talent-query.js 走的就是 evalp。
const BASE = process.env.CDP_BASE || 'http://127.0.0.1:9222';

async function httpJson(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`);
  return await r.json();
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', () => rej(new Error('websocket error')));
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(JSON.stringify(m.error)));
      else res(m.result);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
  });
  return { ws, send };
}

async function pageWs(targetId) {
  const list = await httpJson('/json/list');
  const t = list.find((x) => x.id === targetId);
  if (!t) throw new Error('target not found: ' + targetId);
  if (!t.webSocketDebuggerUrl) throw new Error('target has no webSocketDebuggerUrl (not a page?)');
  return t;
}

async function withTarget(targetId, fn) {
  const t = await pageWs(targetId);
  const { ws, send } = await connect(t.webSocketDebuggerUrl);
  try {
    await send('Runtime.enable');
    try { await send('Page.enable'); } catch (e) { /* worker targets may not support Page */ }
    return await fn(send, t);
  } finally {
    ws.close();
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const fs = await import('node:fs/promises');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (cmd === 'list') {
    const t = await httpJson('/json/list');
    console.log(JSON.stringify(t.filter((x) => x.type === 'page').map((x) => ({ id: x.id, title: x.title, url: x.url })), null, 2));
    return;
  }

  if (cmd === 'open') {
    const ver = await httpJson('/json/version');
    const { ws, send } = await connect(ver.webSocketDebuggerUrl);
    const r = await send('Target.createTarget', { url: rest[0] });
    console.log(JSON.stringify(r));
    ws.close();
    return;
  }

  if (cmd === 'close') {
    const ver = await httpJson('/json/version');
    const { ws, send } = await connect(ver.webSocketDebuggerUrl);
    const r = await send('Target.closeTarget', { targetId: rest[0] });
    console.log(JSON.stringify(r));
    ws.close();
    return;
  }

  if (cmd === 'cookies') {
    const [targetId, urls] = rest;
    const out = await withTarget(targetId, (send) =>
      send('Network.getCookies', { urls: urls ? urls.split(',') : undefined })
    );
    console.log(JSON.stringify(out.cookies.map((c) => ({ name: c.name, domain: c.domain, httpOnly: c.httpOnly, valueLen: (c.value || '').length })), null, 2));
    return;
  }

  // 关键：后台/被遮挡的 Chromium 渲染进程会被冻结，定时器和 Promise 都不再推进，
  // 于是任何 awaitPromise 的 eval 都会永久挂起。做异步动作前先唤醒。
  if (cmd === 'wake') {
    const out = await withTarget(rest[0], async (send) => {
      const r = {};
      const trySend = async (m, p) => { try { await send(m, p || {}); r[m] = 'ok'; } catch (e) { r[m] = 'err:' + e.message; } };
      await trySend('Page.bringToFront');
      await trySend('Emulation.setFocusEmulationEnabled', { enabled: true });
      await trySend('Page.setWebLifecycleState', { state: 'active' });
      await trySend('Emulation.setIdleOverride', { isUserActive: true, isScreenUnlocked: true });
      const st = await send('Runtime.evaluate', {
        expression: 'JSON.stringify({vis:document.visibilityState,hidden:document.hidden,focus:document.hasFocus()})',
        returnByValue: true,
      });
      r.pageState = st.result && st.result.value;
      return r;
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'eval') {
    const [targetId, file] = rest;
    const expr = await fs.readFile(file, 'utf8');
    const out = await withTarget(targetId, (send) =>
      send('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true })
    );
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'evalp') {
    const [targetId, file, argRaw] = rest;
    if (!argRaw) throw new Error('evalp needs <argJsonOrFile>');
    let argText = argRaw;
    try {
      const st = await fs.stat(argRaw);
      if (st.isFile()) argText = await fs.readFile(argRaw, 'utf8');
    } catch (e) { /* treat as inline JSON */ }
    let parsed;
    try { parsed = JSON.parse(argText); } catch (e) { throw new Error('arg is neither a readable JSON file nor inline JSON: ' + e.message); }

    const expr = await fs.readFile(file, 'utf8');
    const out = await withTarget(targetId, async (send) => {
      // 页面被冻结时下面的注入本身仍能成功，但脚本里的异步会卡住 —— 先唤醒兜底
      try { await send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
      try { await send('Page.setWebLifecycleState', { state: 'active' }); } catch (e) {}
      await send('Runtime.evaluate', { expression: `window.__ARG = ${JSON.stringify(parsed)};`, returnByValue: true });
      return await send('Runtime.evaluate', {
        expression: expr, awaitPromise: true, returnByValue: true, userGesture: true,
      });
    });
    if (out.exceptionDetails) {
      console.error(JSON.stringify(out.exceptionDetails, null, 2));
      process.exit(1);
    }
    console.log(typeof out.result?.value === 'string' ? out.result.value : JSON.stringify(out, null, 2));
    return;
  }

  console.error('usage: cdp.mjs list | open <url> | close <id> | cookies <id> <urls> | wake <id> | eval <id> <file> | evalp <id> <file> <json|file>');
  process.exit(2);
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
