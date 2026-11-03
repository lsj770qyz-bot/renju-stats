/* Rapfi (GPL-3.0) WASM 引擎 Worker。
   流式推送：每轮完整 idx=0..9 后立即 postMessage('progress') 给主线程，
   同时降低触发门槛确保首轮就能出结果。 */

importScripts('rapfi-single-simd128.js');

var M = null;
var ready = false;
var currentReq = null;
var sess = null;

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

/* 从 sess.log 解析最新完整 Top-N：从最后一个 idx=0 起，取后面所有有 wr+mv 的 idx */
function parseLatest() {
  var log = sess.log;
  var blocks = [];
  for (var i = 0; i < log.length; i++) {
    var l = log[i];
    if (l.indexOf('INFO PV ') === 0 && l !== 'INFO PV DONE') {
      blocks.push({ idx: parseInt(l.slice(8), 10), wr: null, mv: null });
    } else if (blocks.length) {
      var b = blocks[blocks.length - 1];
      if (l.indexOf('INFO WINRATE ') === 0) b.wr = parseFloat(l.slice(12));
      else if (l.indexOf('INFO BESTLINE ') === 0) b.mv = l.slice(14).trim().split(' ')[0];
    }
  }
  var start = -1;
  for (var j = blocks.length - 1; j >= 0; j--) {
    if (blocks[j].idx === 0) { start = j; break; }
  }
  if (start < 0) return null;
  var round = blocks.slice(start);
  var map = {};
  for (var k = 0; k < round.length; k++) map[round[k].idx] = round[k];
  var out = [];
  for (var idx = 0; idx <= 9; idx++) {
    var b = map[idx];
    if (b && b.wr != null && isFinite(b.wr) && b.mv) {
      var c = cellOfCoord(b.mv);
      if (c >= 0) out.push([c, Math.max(0, Math.min(1, b.wr))]);
    }
  }
  return out.length >= 1 ? out : null;
}

function tryEmitProgress() {
  if (!sess || !currentReq) return;
  var out = parseLatest();
  if (!out) return;
  sess.round++;
  sess.latest = out;
  /* 去抖：每 250ms 最多推一次 */
  if (!sess.lastSendT || Date.now() - sess.lastSendT > 250) {
    sess.lastSendT = Date.now();
    send('progress', out, { id: currentReq.id, ms: sess.lastSendT - sess.startT, round: sess.round });
  }
}

self.onmessage = function (e) {
  var d = e.data || {};
  if (d.type === 'analyze') {
    if (!ready) { send('result', [], { id: d.id, ms: 0, error: 'not-ready' }); return; }
    currentReq = d;
    sess = { log: [], round: 0, startT: Date.now(), latest: null, lastSendT: 0 };

    /* 时间拉长到 4s（浏览器 WASM 比 Node 慢） */
    var t = Math.max(3000, Math.min(6000, d.timeMs || 4000));
    var lines = [];
    var mv = d.moves || [];
    for (var i = 0; i < mv.length; i++) {
      var cell = mv[i][0];
      lines.push((cell % 15) + ',' + Math.floor(cell / 15) + ',' + mv[i][1]);
    }
    M.sendCommand('INFO rule 4');
    M.sendCommand('INFO caution_factor 0');
    M.sendCommand('INFO show_detail 2');
    M.sendCommand('INFO timeout_turn ' + t);
    M.sendCommand('YXBOARD\n' + (lines.length ? lines.join('\n') + '\n' : '') + 'DONE');
    var n = Math.max(4, Math.min(20, d.topN || 12));
    /* 发 YXNBEST → 引擎同步搜索 */
    M.sendCommand('YXNBEST ' + n);
    /* sendCommand 返回时搜索已结束，发最终结果 */
    var final = sess.latest || parseLatest();
    send('result', final || [], { id: d.id, ms: Date.now() - sess.startT, round: sess.round });
    sess = null;
    currentReq = null;
  } else if (d.type === 'ping') {
    send('pong', ready);
  }
};

/* ---------- 启动 + 实时 stdout 回调 ---------- */
Rapfi({
  locateFile: function (p) { return p; },
  onReceiveStdout: function (l) {
    if (!sess) return;
    sess.log.push(l);
    /* INFO BESTLINE 一定紧随 INFO WINRATE（见 Rapfi 源码输出顺序），
       此时 idx=0..N 的 wr 和 mv 都已完整，用 BESTLINE 触发最稳妥 */
    if (l.indexOf('INFO BESTLINE ') === 0) {
      tryEmitProgress();
    } else if (l === 'INFO PV DONE') {
      tryEmitProgress();
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
