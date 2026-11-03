/* Rapfi (GPL-3.0) WASM 引擎 Worker — 持续循环 + 稳定搜索
   关键修复：发完 YXBOARD/YXNBEST 后等 ROUND_TIMEOUT_MS 再拿结果，
   不让 Rapfi 被每轮立即打断重发命令 */

importScripts('rapfi-single-simd128.js');

var M = null;
var ready = false;
var currentReq = null;
var sess = null;
var latestReqId = 0;
var loopTimer = null;
var collectTimer = null;  /* 延迟收集搜索结果的 timer */

/* 每轮搜索 0.5s（快速响应，持续流式推送） */
var ROUND_TIMEOUT_MS = 500;
var LOOP_INTERVAL_MS = 100;       /* 两轮之间的间隔，留时间让事件循环处理新请求 */
var PROGRESS_DEBOUNCE_MS = 200;

function send(type, data, extra) {
  var msg = { type: type };
  if (data !== undefined) msg.data = data;
  if (extra) for (var k in extra) msg[k] = extra[k];
  self.postMessage(msg);
}

function cellOfCoord(str) {
  if (!str) return -1;
  var parts = str.split(',');
  if (parts.length < 2) return -1;
  var x = parseInt(parts[0], 10), y = parseInt(parts[1], 10);
  if (!isFinite(x) || !isFinite(y)) return -1;
  return y * 15 + x;
}

function buildOut() {
  if (!sess || !sess.map) return null;
  var map = sess.map;
  var out = [];
  for (var idx = 0; idx <= 9; idx++) {
    var b = map[idx];
    if (b && b.wr != null && b.mv) {
      var c = cellOfCoord(b.mv);
      if (c >= 0) out.push([c, Math.max(0, Math.min(1, b.wr))]);
    }
  }
  return out.length >= 1 ? out : null;
}

function tryEmitProgress() {
  if (!sess || !currentReq) return;
  if (currentReq.id !== latestReqId) return;
  var out = buildOut();
  if (!out) return;
  sess.latest = out;
  sess.progressCount = (sess.progressCount || 0) + 1;
  var now = Date.now();
  if (now - sess.lastSendT >= PROGRESS_DEBOUNCE_MS) {
    sess.lastSendT = now;
    send('progress', out, { id: currentReq.id, ms: now - sess.startT, round: sess.round });
  }
}

/* 延迟收集结果：等 ROUND_TIMEOUT_MS 后从 sess.map 拿最终结果 */
function collectAndSendResult() {
  collectTimer = null;
  if (!currentReq || currentReq.id !== latestReqId) { sess = null; return; }
  var final = buildOut();
  if (!final) {
    /* 如果还没搜出任何结果，再等 1s */
    collectTimer = setTimeout(function () {
      collectTimer = null;
      if (!currentReq || currentReq.id !== latestReqId) { sess = null; return; }
      var final2 = buildOut();
      sess.latest = final2 || sess.latest || [];
      send('result', final2 || sess.latest || [], {
        id: currentReq.id, ms: Date.now() - sess.startT, round: sess.round, noData: !final2
      });
      scheduleNextRound();
    }, 1000);
    return;
  }
  sess.latest = final;
  send('result', final, { id: currentReq.id, ms: Date.now() - sess.startT, round: sess.round });
  scheduleNextRound();
}

/* 启动下一轮 —— 只发一次 YXBOARD/YXNBEST，让 Rapfi 持续计算 */
function scheduleNextRound() {
  if (!currentReq || currentReq.id !== latestReqId) { sess = null; currentReq = null; return; }
  loopTimer = setTimeout(function () {
    loopTimer = null;
    runRound();
  }, LOOP_INTERVAL_MS);
}

/* 跑一轮：发命令 → 等超时 → 收集结果 */
function runRound() {
  if (!currentReq || currentReq.id !== latestReqId) {
    sess = null; currentReq = null; return;
  }
  
  /* 初始化/重置 session map，但保留上一次的 latest 作为 fallback */
  var prevLatest = sess ? sess.latest : null;
  sess = {
    map: {}, round: sess ? sess.round + 1 : 1,
    startT: sess ? sess.startT : Date.now(),
    latest: prevLatest,
    lastSendT: 0, cur: null, progressCount: 0
  };
  
  console.log('[RAPFI] runRound START id=' + currentReq.id + ' round=' + sess.round);
  
  /* 每轮都重新发 YXBOARD + YXNBEST —— Rapfi 需要这个来持续搜索当前局面 */
  M.sendCommand('INFO rule 4');
  M.sendCommand('INFO caution_factor 0');
  M.sendCommand('INFO show_detail 2');
  M.sendCommand('INFO timeout_turn ' + ROUND_TIMEOUT_MS);
  M.sendCommand('YXBOARD\n' + currentReq.boardText + 'DONE');
  M.sendCommand('YXNBEST ' + (currentReq.topN || 10));
  
  /* 关键修改：不立即 buildOut！等 ROUND_TIMEOUT_MS 让 Rapfi 真正算够 */
  collectTimer = setTimeout(collectAndSendResult, ROUND_TIMEOUT_MS);
}

self.onmessage = function (e) {
  var d = e.data || {};
  if (d.type === 'analyze') {
    latestReqId = d.id;
    console.log('[RAPFI] onmessage analyze id=' + d.id + ' current=' + (currentReq ? currentReq.id : 'null'));
    
    /* 取消所有定时器，干净开始 */
    if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
    if (collectTimer) { clearTimeout(collectTimer); collectTimer = null; }
    
    if (!ready) { send('result', [], { id: d.id, ms: 0, error: 'not-ready' }); return; }
    
    var lines = [];
    var mv = d.moves || [];
    for (var i = 0; i < mv.length; i++) {
      var cell = mv[i][0];
      lines.push((cell % 15) + ',' + Math.floor(cell / 15) + ',' + mv[i][1]);
    }
    d.boardText = lines.length ? lines.join('\n') + '\n' : '';
    
    currentReq = d;
    sess = null;  /* 清掉旧 session，startT 重新计时 */
    
    runRound();
    
  } else if (d.type === 'ping') {
    send('pong', ready);
  }
};

/* ---------- 启动 + stdout 增量解析 ---------- */
var _dbgCount = 0;
Rapfi({
  locateFile: function (p) { return p; },
  onReceiveStdout: function (l) {
    if (!sess) return;
    if (_dbgCount++ % 30 === 0) console.log('[RAPFI-DBG] stdout:', l.slice(0, 80));
    if (currentReq && currentReq.id !== latestReqId) return;
    if (l.indexOf('INFO PV ') === 0 && l !== 'INFO PV DONE') {
      sess.cur = parseInt(l.slice(8), 10);
    } else if (sess.cur != null) {
      var b = sess.map[sess.cur] = sess.map[sess.cur] || {};
      if (l.indexOf('INFO WINRATE ') === 0) b.wr = parseFloat(l.slice(12));
      else if (l.indexOf('INFO BESTLINE ') === 0) {
        b.mv = l.slice(14).trim().split(' ')[0];
        tryEmitProgress();
      }
      if (l === 'INFO PV DONE') sess.cur = null;
    }
  },
  onReceiveStderr: function (l) { if (l) console.log('[RAPFI-ERR]', l.slice(0, 120)); },
  print: function (l) { if (l) console.log('[RAPFI-PRINT]', l.slice(0, 120)); },
  printErr: function (l) { if (l) console.log('[RAPFI-PRINTERR]', l.slice(0, 120)); }
}).then(function (mod) {
  M = mod;
  M.sendCommand('INFO rule 4');
  M.sendCommand('INFO caution_factor 0');
  M.sendCommand('INFO show_detail 2');
  M.sendCommand('START 15');
  ready = true;
  send('status', 'ready');
}).catch(function (err) {
  send('status', 'error', { message: String(err) });
});
