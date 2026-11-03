/* Rapfi (GPL-3.0) WASM 引擎 Worker。
   ⚠️ sendCommand('YXNBEST') 会**同步阻塞** JS 事件循环直到搜索结束
      （时间 = timeout_turn 值），但 onReceiveStdout 在阻塞期间会被
      WASM 同步逐行回调——这就是唯一的"实时"通道。
   
   所以 progress 推送必须在 onReceiveStdout 回调里做：每当检测到
   INFO PV 9 + INFO WINRATE + INFO BESTLINE 完成一轮，就立即
   postMessage('progress', ...) 给主线程。主线程 draw() 也是同步
   执行 canvas 绘制的，所以会在这一轮 stdout 回调链里立刻刷新。 */

importScripts('rapfi-single-simd128.js');

var M = null;
var ready = false;
var currentReq = null;

/* 当前会话状态（每个 analyze 请求独立一份） */
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

/* ---------- 每条 stdout 行实时到达时调用 ---------- */
function onStdoutLine(line) {
  if (!sess) return;
  sess.log.push(line);

  /* 捕获 INFO PV 块：以 INFO PV idx 开始，接下来几行是 WINRATE / BESTLINE
     当我们看到 INFO PV DONE 且前一个是 idx=9，说明一整轮完整结束 */
  if (line.indexOf('INFO PV ') === 0 && line !== 'INFO PV DONE') {
    var idx = parseInt(line.slice(8), 10);
    sess.cur = { idx: idx, wr: null, mv: null };
  } else if (sess.cur) {
    if (line.indexOf('INFO WINRATE ') === 0) sess.cur.wr = parseFloat(line.slice(12));
    else if (line.indexOf('INFO BESTLINE ') === 0) sess.cur.mv = line.slice(14).trim().split(' ')[0];
    else if (line === 'INFO PV DONE' && sess.cur.idx === 9) {
      /* 一整轮（PV 0..9）刚刚完整到达，现在汇总 */
      emitProgress();
    }
  }

  /* DONE 也可能出现在每轮中间，不需要特殊处理 */
}

function emitProgress() {
  if (!sess || !currentReq) return;
  sess.round++;
  sess.roundTime = Date.now();

  /* 从 sess.log 找最后一轮的 idx=0 开始 */
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

  if (out.length >= 4) {
    sess.latest = out;
    /* 防抖动：至少间隔 200ms 推一次（主线程 draw() 也是同步的，太频繁会卡） */
    if (!sess.lastSendT || Date.now() - sess.lastSendT > 200) {
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
    /* 每请求独立会话 */
    sess = { log: [], round: 0, startT: Date.now(), cur: null, latest: null, lastSendT: 0 };

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
    /* 发 YXNBEST → 引擎同步搜索 timeout_turn 毫秒，期间 onReceiveStdout 被持续调用 */
    M.sendCommand('YXNBEST ' + n);

    /* sendCommand 返回时，引擎已停，发最终 result */
    var final = sess.latest;
    send('result', final || [], { id: d.id, ms: Date.now() - sess.startT, round: sess.round });
    sess = null;
    currentReq = null;
  } else if (d.type === 'ping') {
    send('pong', ready);
  }
};

/* ---------- 启动引擎 ---------- */
Rapfi({
  locateFile: function (p) { return p; },
  onReceiveStdout: function (l) { onStdoutLine(l); },   /* 实时回调 */
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
  console.error('Rapfi init failed:', err);
  send('status', 'error', { message: String(err) });
});
