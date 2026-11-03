/* Rapfi (GPL-3.0) WASM 引擎 Worker — 持续循环 + 流式
   timeout 2500ms（每轮多 1s 深搜），循环间隔 50ms，200ms 去抖流式 */

importScripts('rapfi-single-simd128.js');

var M = null;
var ready = false;
var currentReq = null;
var sess = null;
var latestReqId = 0;
var loopTimer = null;

/* 每轮搜索 2.5s，持续循环直到用户关闭按钮 */
var ROUND_TIMEOUT_MS = 2500;
var LOOP_INTERVAL_MS = 50;
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

/* 跑一轮 YXNBEST（同步阻塞 ~2.5s），跑完 setTimeout 再跑下一轮 */
function runRound() {
  if (!currentReq || currentReq.id !== latestReqId) {
    sess = null;
    return; /* 请求已取消 */
  }
  sess = { map: {}, round: sess ? sess.round : 0, startT: sess ? sess.startT : Date.now(),
           latest: sess ? sess.latest : null, lastSendT: 0, cur: null };
  
  /* 每轮都重新建立局面 + 设置参数（安全，Rapfi 支持重复发送） */
  M.sendCommand('INFO rule 4');
  M.sendCommand('INFO caution_factor 0');
  M.sendCommand('INFO show_detail 2');
  M.sendCommand('INFO timeout_turn ' + ROUND_TIMEOUT_MS);
  M.sendCommand('YXBOARD\n' + currentReq.boardText + 'DONE');
  M.sendCommand('YXNBEST ' + (currentReq.topN || 10));
  
  /* 本轮结束，发 final result，然后循环 */
  var final = buildOut();
  if (currentReq && currentReq.id === latestReqId) {
    send('result', final || sess.latest || [], { id: currentReq.id, ms: Date.now() - sess.startT, round: sess.round });
  }
  
  if (currentReq && currentReq.id === latestReqId) {
    /* 短间隔释放事件循环，让主线程消息能进来 */
    loopTimer = setTimeout(runRound, LOOP_INTERVAL_MS);
  } else {
    sess = null;
    currentReq = null;
  }
}

self.onmessage = function (e) {
  var d = e.data || {};
  if (d.type === 'analyze') {
    latestReqId = d.id;  /* 标记新请求，旧的自动作废 */
    if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
    if (!ready) { send('result', [], { id: d.id, ms: 0, error: 'not-ready' }); return; }
    
    /* 序列化棋盘 —— 只做数据准备，不 sendCommand（避免阻塞 onmessage） */
    var lines = [];
    var mv = d.moves || [];
    for (var i = 0; i < mv.length; i++) {
      var cell = mv[i][0];
      lines.push((cell % 15) + ',' + Math.floor(cell / 15) + ',' + mv[i][1]);
    }
    d.boardText = lines.length ? lines.join('\n') + '\n' : '';
    
    currentReq = d;
    /* setTimeout 0 让 onmessage 先返回（释放 Worker 事件循环），再跑第一轮 */
    setTimeout(runRound, 0);
    
  } else if (d.type === 'ping') {
    send('pong', ready);
  }
};

/* ---------- 启动 + 增量 stdout ---------- */
Rapfi({
  locateFile: function (p) { return p; },
  onReceiveStdout: function (l) {
    if (!sess) return;
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
  onReceiveStderr: function () {},
  print: function () {},
  printErr: function () {}
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
