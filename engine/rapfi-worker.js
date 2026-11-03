/* Rapfi (GPL-3.0) WASM 引擎 Worker — 持续循环搜索 + 流式推送
   按下按钮后：一直循环 YXNBEST（每轮 1500ms timeout），直到用户关闭按钮
   每轮内部增量流式推送（~200ms 去抖） */

importScripts('rapfi-single-simd128.js');

var M = null;
var ready = false;
var currentReq = null;
var sess = null;
var latestReqId = 0;
var loopTimer = null;

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
  if (now - sess.lastSendT >= 200) {
    sess.lastSendT = now;
    send('progress', out, { id: currentReq.id, ms: now - sess.startT, round: sess.round });
  }
}

/* 跑一轮 YXNBEST（同步阻塞 ~1.5s），跑完 setTimeout 再跑下一轮 */
function runRound() {
  if (!currentReq || currentReq.id !== latestReqId) {
    sess = null;
    return; /* 请求已取消 */
  }
  sess = { map: {}, round: sess ? sess.round : 0, startT: sess ? sess.startT : Date.now(),
           latest: sess ? sess.latest : null, lastSendT: 0, cur: null };
  
  M.sendCommand('INFO timeout_turn 1500');
  M.sendCommand('YXBOARD\n' + currentReq.boardText + 'DONE');
  M.sendCommand('YXNBEST ' + (currentReq.topN || 10));
  
  /* 本轮结束，发 final result，然后循环 */
  var final = buildOut();
  if (currentReq && currentReq.id === latestReqId) {
    send('result', final || sess.latest || [], { id: currentReq.id, ms: Date.now() - sess.startT, round: sess.round });
  }
  
  if (currentReq && currentReq.id === latestReqId) {
    /* 100ms 间隔释放事件循环，让主线程消息能进来 */
    loopTimer = setTimeout(runRound, 100);
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
    
    /* 序列化棋盘 */
    var lines = [];
    var mv = d.moves || [];
    for (var i = 0; i < mv.length; i++) {
      var cell = mv[i][0];
      lines.push((cell % 15) + ',' + Math.floor(cell / 15) + ',' + mv[i][1]);
    }
    d.boardText = lines.length ? lines.join('\n') + '\n' : '';
    
    /* 先发 YXBOARD 建立局面 */
    M.sendCommand('INFO rule 4');
    M.sendCommand('INFO caution_factor 0');
    M.sendCommand('INFO show_detail 2');
    M.sendCommand('INFO timeout_turn 1500');
    M.sendCommand('YXBOARD\n' + d.boardText + 'DONE');
    
    currentReq = d;
    runRound();  /* 立即开始第一轮（同步阻塞 ~1.5s），之后自动循环 */
    
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
