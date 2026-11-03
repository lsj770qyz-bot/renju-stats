/* Rapfi (GPL-3.0) WASM 引擎 Worker — 带详细 debug log
   把 onReceiveStdout 收到的每一行都 postMessage 回主线程，
   让主线程能看到 Rapfi 实际输出了什么，从而定位流式为什么不工作。 */

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

function emitProgress() {
  if (!sess || !currentReq) return;
  sess.round++;
  sess.roundTime = Date.now();

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
  var start = 0;
  for (var j = blocks.length - 1; j >= 0; j--) if (blocks[j].idx === 0) { start = j; break; }
  var round = blocks.slice(start);
  var map = {};
  for (var k = 0; k < round.length; k++) map[round[k].idx] = round[k];
  var out = [];
  for (var idx = 0; idx <= 9; idx++) {
    var b = map[idx];
    if (b && b.wr != null && isFinite(b.wr)) {
      var c = cellOfCoord(b.mv);
      if (c >= 0) out.push([c, Math.max(0, Math.min(1, b.wr))]);
    }
  }

  send('_dbg', 'emitProgress round=' + sess.round + ' logLen=' + log.length + ' blocks=' + blocks.length + ' outLen=' + out.length);

  if (out.length >= 4) {
    sess.latest = out;
    if (!sess.lastSendT || Date.now() - sess.lastSendT > 150) {
      sess.lastSendT = Date.now();
      send('progress', out, { id: currentReq.id, ms: sess.lastSendT - sess.startT, round: sess.round });
    }
  }
}

self.onmessage = function (e) {
  var d = e.data || {};
  if (d.type === 'analyze') {
    if (!ready) { send('result', [], { id: d.id, ms: 0, error: 'not-ready' }); return; }
    currentReq = d;
    sess = { log: [], round: 0, startT: Date.now(), cur: null, latest: null, lastSendT: 0 };
    send('_dbg', 'ANALYZE start id=' + d.id);

    var t = Math.max(1500, Math.min(5000, d.timeMs || 2500));
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

    send('_dbg', 'BEFORE YXNBEST  logLen=' + sess.log.length);
    var t0 = Date.now();
    M.sendCommand('YXNBEST ' + n);
    send('_dbg', 'AFTER YXNBEST  blocked_ms=' + (Date.now() - t0) + ' logLen=' + sess.log.length + ' rounds=' + sess.round);

    var final = sess.latest;
    send('result', final || [], { id: d.id, ms: Date.now() - sess.startT, round: sess.round });
    sess = null;
    currentReq = null;
  } else if (d.type === 'ping') {
    send('pong', ready);
  }
};

/* ---------- 启动 ---------- */
Rapfi({
  locateFile: function (p) { return p; },
  onReceiveStdout: function (l) {
    /* 每条 stdout 都转发到主线程方便 debug（限 PV/WINRATE/BESTLINE/DONE 这些） */
    if (l.indexOf('INFO PV ') === 0 || l.indexOf('INFO WINRATE ') === 0 ||
        l.indexOf('INFO BESTLINE ') === 0 || l.indexOf('INFO PV DONE') === 0) {
      /* 注意：postMessage 自己也走主线程队列，这里不能同步触发主线程 handler，
         但 self.postMessage 本身开销极小 */
      // self.postMessage({ type: '_dbg_line', data: l });  // 太吵，关掉
    }

    if (!sess) return;
    sess.log.push(l);

    if (l.indexOf('INFO PV ') === 0 && l !== 'INFO PV DONE') {
      sess.cur = { idx: parseInt(l.slice(8), 10), wr: null, mv: null };
    } else if (sess.cur) {
      if (l.indexOf('INFO WINRATE ') === 0) sess.cur.wr = parseFloat(l.slice(12));
      else if (l.indexOf('INFO BESTLINE ') === 0) sess.cur.mv = l.slice(14).trim().split(' ')[0];
      else if (l === 'INFO PV DONE' && sess.cur.idx === 9) {
        emitProgress();
      }
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
