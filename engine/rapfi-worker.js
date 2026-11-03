/* Rapfi (GPL-3.0) WASM 引擎 Worker — 增量流式推送
   优化：不再存 sess.log / 不再每次全量扫描重建 blocks，
   而是在 onReceiveStdout 里直接维护 sess.map[idx] = {wr, mv}。
   每条 BESTLINE 触发时 O(1) 构建 out 数组并 postMessage。 */

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

/* 根据 sess.map 构建最新 Top-N 输出 —— O(1) */
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
  var out = buildOut();
  if (!out) return;
  sess.round++;
  sess.latest = out;
  /* 去抖：每 200ms 最多推一次（快但不卡） */
  var now = Date.now();
  if (now - sess.lastSendT >= 200) {
    sess.lastSendT = now;
    send('progress', out, { id: currentReq.id, ms: now - sess.startT, round: sess.round });
  }
}

self.onmessage = function (e) {
  var d = e.data || {};
  if (d.type === 'analyze') {
    if (!ready) { send('result', [], { id: d.id, ms: 0, error: 'not-ready' }); return; }
    currentReq = d;
    sess = { map: {}, round: 0, startT: Date.now(), latest: null, lastSendT: 0 };

    /* timeout 默认 2s，用户嫌慢就设 2000ms */
    var t = Math.max(1200, Math.min(3000, d.timeMs || 2000));
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
    var n = Math.max(4, Math.min(20, d.topN || 10));
    M.sendCommand('YXNBEST ' + n);
    /* sendCommand 返回 → 发最终 result */
    var final = sess.latest || buildOut();
    send('result', final || [], { id: d.id, ms: Date.now() - sess.startT, round: sess.round });
    sess = null;
    currentReq = null;
  } else if (d.type === 'ping') {
    send('pong', ready);
  }
};

/* ---------- 启动 + 增量 stdout 回调 ---------- */
Rapfi({
  locateFile: function (p) { return p; },
  onReceiveStdout: function (l) {
    if (!sess) return;
    /* 实时增量维护 sess.map，O(1) 操作 */
    if (l.indexOf('INFO PV ') === 0 && l !== 'INFO PV DONE') {
      var idx = parseInt(l.slice(8), 10);
      sess.cur = idx;
    } else if (sess.cur != null) {
      var b = sess.map[sess.cur] = sess.map[sess.cur] || {};
      if (l.indexOf('INFO WINRATE ') === 0) {
        b.wr = parseFloat(l.slice(12));
      } else if (l.indexOf('INFO BESTLINE ') === 0) {
        b.mv = l.slice(14).trim().split(' ')[0];
        /* BESTLINE 到了 → 这个 idx 完整了 → 立即尝试 emitProgress */
        tryEmitProgress();
      }
      /* PV DONE 不单独触发，因为紧随 BESTLINE 之后 */
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
