// 在抖音来客页面里执行的取数脚本。由 cdp.mjs evalp 注入 window.__ARG 后调用。
//
//   参数（JSON 文件）：{ root, op, ... }
//   root  = root_life_account_id（可用 op:"whoami" 自动取）
//
// op 取值：
//   whoami   从页面已发生的请求里挖出 root_life_account_id
//   search   按昵称搜达人，返回候选列表（含异地同名者，需上层消歧）
//   cityPool 拉某个城市的达人池分页，按 nameRegex 过滤 —— 用于 emoji/生僻昵称搜不到时兜底
//   fields   按 uid 取字段（粉丝量/带货等级/带货金额/品类金额/订单地域）
//
// 金额单位：抖音接口的 digit_value 是「分」，除以 100 才是元。
(function () {
  var A = window.__ARG || {};
  var API = '/life/alliance/v1/merchant/talent_square/talent/';

  function withTimeout(p, ms) {
    return Promise.race([p, new Promise(function (r) { setTimeout(function () { r({ status: -2, text: 'TIMEOUT' }); }, ms); })]);
  }

  // 用 XHR 而不是 fetch：页面里的 fetch 可能被反爬 SDK 接管后永久 pending，
  // XHR 是页面自己一直在用的通道，稳定得多。
  function req(method, path, body, ms) {
    var url = path + (path.indexOf('?') >= 0 ? '&' : '?') + 'root_life_account_id=' + A.root;
    return withTimeout(new Promise(function (res) {
      var x = new XMLHttpRequest();
      x.open(method, url, true);
      x.setRequestHeader('Accept', 'application/json, text/plain, */*');
      x.setRequestHeader('x-mt-fe-platform', 'life_merchant_pc');
      x.setRequestHeader('x-mt-fe-project', 'merchant_pc');
      x.setRequestHeader('x-mt-fe-release', '1.0.0.6793');
      if (body) x.setRequestHeader('Content-Type', 'application/json');
      x.onreadystatechange = function () {
        if (x.readyState === 4) res({ status: x.status, text: String(x.responseText || '') });
      };
      x.onerror = function () { res({ status: -1, text: 'network error' }); };
      try { x.send(body ? JSON.stringify(body) : undefined); } catch (e) { res({ status: -3, text: 'send error ' + e }); }
    }), ms || 25000);
  }

  function json(r) { try { return JSON.parse(r.text); } catch (e) { return null; } }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function num(v) { var n = parseFloat(String(v).replace(/[^\d.]/g, '')); return isFinite(n) ? n : NaN; }

  // 平台口径：>=1万 显示 "X.XX万"，不足 1 万直接显示元。统一换算成 "X.XXw"。
  function toW(value, notation) {
    var s = String(value == null ? '' : value).trim();
    if (s === '') return '';
    if (s === '<100') return '<0.01w';
    if (/[<>]/.test(s)) return s;
    var n = num(s);
    if (!isFinite(n)) return s;
    return ((String(notation || '').indexOf('万') >= 0) ? n : n / 10000).toFixed(2) + 'w';
  }

  function searchBody(extra) {
    var o = { enable_filter_item_params: true, request_source: 2, page: 1, page_size: 20, from_type: 5 };
    for (var k in extra) o[k] = extra[k];
    return o;
  }

  function slim(t) {
    return {
      nick: t.nick_name, uid: t.uid, dy: t.unique_id, fans: t.fans_count,
      itemLv: t.item_level, liveLv: t.live_level, contentLv: t.content_level,
      city: t.city_name || '', resident: t.resident_city_name || '',
    };
  }

  var OP = {};

  OP.whoami = function () {
    var found = '';
    var rs = performance.getEntriesByType('resource') || [];
    for (var i = 0; i < rs.length; i++) {
      var m = String(rs[i].name || '').match(/root_life_account_id=(\d+)/);
      if (m) { found = m[1]; break; }
    }
    if (!found) {
      try {
        for (var s = 0; s < localStorage.length; s++) {
          var v = localStorage.getItem(localStorage.key(s)) || '';
          var mm = v.match(/root_life_account_id"?\s*[:=]\s*"?(\d+)/);
          if (mm) { found = mm[1]; break; }
        }
      } catch (e) {}
    }
    return { root: found, source: found ? 'page' : 'not-found', resourceCount: rs.length };
  };

  OP.search = function () {
    var body = searchBody({ keyword: A.keyword, page_size: A.pageSize || 30 });
    if (A.filter) body.filter_item_params = A.filter;
    return req('POST', API + 'search/', body, 25000).then(function (r) {
      var j = json(r);
      if (!j) return { error: 'parse', status: r.status, head: r.text.slice(0, 200) };
      var list = j.talent_list || [];
      return { keyword: A.keyword, total: j.total_count, n: list.length, candidates: list.map(slim) };
    });
  };

  OP.cityPool = function () {
    var pages = A.pages || 8;
    var size = A.pageSize || 50;
    var rex = new RegExp(A.nameRegex || '.', 'i');
    var filter = A.filter || { provinceCity: [A.city || '230200'] };
    var hits = [];
    var meta = [];

    function onePage(p) {
      return req('POST', API + 'search/', searchBody({ page: p, page_size: size, filter_item_params: filter }), 25000)
        .then(function (r) {
          var j = json(r);
          if (!j) { meta.push('p' + p + ' parse err'); return sleep(120); }
          var list = j.talent_list || [];
          meta.push('p' + p + ' n=' + list.length + ' total=' + j.total_count);
          list.forEach(function (t) {
            if (rex.test(t.nick_name || '')) {
              var s = slim(t);
              s.page = p;
              hits.push(s);
            }
          });
          return sleep(120);
        });
    }

    var chain = Promise.resolve();
    for (var p = 1; p <= pages; p++) chain = chain.then(onePage.bind(null, p));
    return chain.then(function () { return { meta: meta, hits: hits }; });
  };

  OP.fields = function () {
    var pairs = A.uids || [];
    var category = A.category || null;
    var out = [];

    function one(pair) {
      var name = pair[0], uid = pair[1];
      var rec = { name: name, uid: uid };

      return req('GET', API + 'detail/?from_type=5&uid=' + uid).then(function (r) {
        var j = json(r);
        var d = j && j.talent_detail;
        if (d) {
          rec.nick = d.nick_name; rec.dy = d.unique_id;
          rec.city = d.city_name || d.resident_city_name || '';
          rec.intro = String(d.self_intro || '').replace(/\s+/g, ' ').slice(0, 90);
          var di = d.talent_display_info || {};
          var sv = (di.fans_count_display && di.fans_count_display.statistice_value) || {};
          // 粉丝量 = 粉丝指数；带货等级 = 视频带货力（不是 level / 「带货力」）
          rec.fansRaw = (sv.value || '') + (sv.notation || '');
          rec.fansW = toW(sv.value, sv.notation);
          rec.levelItem = di.talent_item_level_display ? (di.talent_item_level_display.statistice_value || {}).value : '';
          rec.levelLive = di.talent_live_level_display ? (di.talent_live_level_display.statistice_value || {}).value : '';
        } else { rec.detailErr = r.status + ' ' + r.text.slice(0, 120); }
        return sleep(150);
      }).then(function () {
        return req('GET', API + 'total/indicator/?from_type=5&uid=' + uid).then(function (r) {
          var j = json(r);
          var s = j && j.talent_total_statistice;
          if (s && s.talent_total_gmv) {
            var sv = s.talent_total_gmv.statistice_value || {};
            // 带货金额 = 详情页「30日总销售额」
            rec.gmv30Raw = (sv.value || '') + (sv.notation || '');
            rec.gmv30W = toW(sv.value, sv.notation);
            // 订单地域是消歧的关键证据：本地商家对应的达人，第一位必然是本市
            rec.orderArea = (s.order_user_area_rate || []).slice(0, 3).map(function (x) { return x.label + ' ' + x.statistice_value.value + '%'; }).join(', ');
            rec.verifyRate = s.verify_rate_30d ? s.verify_rate_30d.statistice_value.value : '';
          } else { rec.totalErr = r.status; }
          return sleep(150);
        });
      }).then(function () {
        if (!category) return;
        // 品类口径：带 category 时 talent_item_gmv 就是该品类的销售额（精确值）。
        // 不带 category 时返回的 talent_great_category_data 只有 top5 占比，拿占比乘总销售额只是估算。
        return req('GET', API + 'detail/indicator/?uid=' + uid + '&media_type=1&date_n=' + (A.dateN || 30) + '&category=' + encodeURIComponent(category) + '&from_type=5').then(function (r) {
          var j = json(r);
          var s = j && j.talent_item_statistice;
          if (s && s.talent_item_gmv) {
            var sv = s.talent_item_gmv.statistice_value || {};
            rec.categoryName = category;
            rec.categoryRaw = (sv.value || '') + (sv.notation || '');
            rec.categoryW = toW(sv.value, sv.notation);
          } else { rec.categoryErr = r.status; }
          return sleep(150);
        });
      }).then(function () { out.push(rec); });
    }

    var chain = Promise.resolve();
    pairs.forEach(function (pair) { chain = chain.then(one.bind(null, pair)); });
    return chain.then(function () { return { category: category, rows: out }; });
  };

  if (!OP[A.op]) return JSON.stringify({ error: 'unknown op: ' + A.op, known: Object.keys(OP) });
  return Promise.resolve(OP[A.op]()).then(function (r) { return JSON.stringify(r); });
})()
