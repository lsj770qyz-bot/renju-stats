/* Rapfi (GPL-3.0) WASM 引擎 Worker — 持续循环 + 快速响应
   timeout 2000ms，循环间隔 0ms（让新 analyze 优先） */

importScripts('rapfi-single-simd128.js');

var M = null;
var ready = false;
var currentReq = null;
var sess = null;
var latestReqId = 0;
var loopTimer = null;
var busy = false;  /* 当前 runRound 正在阻塞 */

/* 每轮搜索 2s（平衡深度与响应速度） */
var ROUND_TIMEOUT_MS = 2000;
var LOOP_INTERVAL_MS = 0;        /* 0ms：让事件循环先排空 onmessage，再循环 */
var PROGRESS_DEBOUNCE_MS = 180;  /* 去抖间隔 */

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
  sess.round++;
  sess.latest = out;
  var now = Date.now();
  if (now - sess.lastSendT >= PROGRESS_DEBOUNCE_MS) {
    sess.lastSendT = now;
    send('progress', out, { id: currentReq.id, ms: now - sess.startT, round: sess.round });
  }
}

/* 跑一轮 YXNBEST（同步阻塞 ~1.2s），跑完 loopInterval 后再检查是否继续 */
function runRound() {
  busy = true;
  if (!currentReq || currentReq.id !== latestReqId) {
    console.log('[RAPFI] runRound SKIP current=' + (currentReq?currentReq.id:'null') + ' latest=' + latestReqId);
    sess = null; busy = false;
    return; /* 请求已取消 */
  }
  sess = { map: {}, round: sess ? sess.round : 0, startT: sess ? sess.startT : Date.now(),
           latest: sess ? sess.latest : null, lastSendT: 0, cur: null };
  console.log('[RAPFI] runRound START id=' + currentReq.id + ' boardLen=' + currentReq.boardText.length);
  
  /* 每轮都重新建立局面 + 设置参数（安全，Rapfi 支持重复发送） */
  M.sendCommand('INFO rule 4');
  M.sendCommand('INFO caution_factor 0');
  M.sendCommand('INFO show_detail 2');
  M.sendCommand('INFO timeout_turn ' + ROUND_TIMEOUT_MS);
  M.sendCommand('YXBOARD\n' + currentReq.boardText + 'DONE');
  M.sendCommand('YXNBEST ' + (currentReq.topN || 10));
  
  busy = false;
  /* 本轮结束，发 final result */
  var final = buildOut();
  console.log('[RAPFI] runRound END id=' + currentReq.id + ' len=' + (final?final.length:0));
  if (currentReq && currentReq.id === latestReqId) {
    send('result', final || sess.latest || [], { id: currentReq.id, ms: Date.now() - sess.startT, round: sess.round });
  }
  
  /* 关键：先让事件循环跑（0ms），让新 onmessage analyze 被处理 */
  /* 如果 latestReqId 没变 → 继续循环；变了 → 新的 onmessage 会接管 */
  loopTimer = setTimeout(function () {
    loopTimer = null;
    if (!currentReq || currentReq.id !== latestReqId) {
      sess = null; currentReq = null;
      return;
    }
    runRound();  /* 继续下一轮 */
  }, LOOP_INTERVAL_MS);
}

self.onmessage = function (e) {
  var d = e.data || {};
  if (d.type === 'analyze') {
    latestReqId = d.id;  /* 标记新请求，旧的自动作废 */
    console.log('[RAPFI] onmessage analyze id=' + d.id + ' current=' + (currentReq ? currentReq.id : 'null'));
    if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
    if (!ready) { send('result', [], { id: d.id, ms: 0, error: 'not-ready' }); return; }
    
    /* 序列化棋盘 —— 快速准备 */
    var lines = [];
    var mv = d.moves || [];
    for (var i = 0; i < mv.length; i++) {
      var cell = mv[i][0];
      lines.push((cell % 15) + ',' + Math.floor(cell / 15) + ',' + mv[i][1]);
    }
    d.boardText = lines.length ? lines.join('\n') + '\n' : '';
    
    currentReq = d;
    sess = null;  /* 清掉旧 session */
    
    /* 直接同步跑第一轮（和旧版一样稳定），之后 runRound 内部会 setTimeout 循环 */
    runRound();
    
  } else if (d.type === 'ping') {
    send('pong', ready);
  }
};

/* ---------- 启动 + 增量 stdout ---------- */
var _dbgCount = 0;
Rapfi({
  locateFile: function (p) { return p; },
  onReceiveStdout: function (l) {
    if (!sess) return;
    /* 采样：每 10 条打印 1 条，避免刷屏 */
    if (_dbgCount++ % 20 === 0) console.log('[RAPFI-DBG] stdout:', l.slice(0, 80));
    if (currentReq && currentReq.id !== latestReqId) return;
    if (l.indexOf('INFO PV ') === 0 && l !== 'INFO PV DONE') {
      sess.cur = parseInt(l.slice(8), 10);
    } else if (sess.cur != null) {
      var b = sess.map[sess.cur] = sess.map[sess.cur] || {};
      if (l.indexOf('INFO WINRATE ') === 0) b.wr = parseFloat(l.slice(12));
      else if (l.indexOf('INFO BESTLINE ') === 0) { b.mv = l.slice(14).trim().split(' ')[0]; tryEmitProgress(); }
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
