/* Rapfi (GPL-3.0) WASM 引擎封装：在 Web Worker 中运行，主线程只负责收发消息。
   协议：Gomocup / YixinBoard 扩展（YXBOARD / YXNBEST）。
   输入一条 analyze 请求 → 输出每个候选点的胜率（下一手方视角，0..1）。 */

importScripts('rapfi-single-simd128.js');

var LOG = [];
var M = null;
var ready = false;
var failed = false;
var pendingReq = null;
var scheduled = false;

function send(type, data, extra) {
  var msg = { type: type };
  if (data !== undefined) msg.data = data;
  if (extra) for (var k in extra) msg[k] = extra[k];
  self.postMessage(msg);
}

/* ---------- 解析 INFO PV 块 ---------- */
function parseBlocks(lines) {
  var blocks = [];
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (l.indexOf('INFO PV ') === 0 && l !== 'INFO PV DONE') {
      blocks.push({ idx: parseInt(l.slice(8), 10), wr: null, mv: null });
    } else if (blocks.length) {
      var b = blocks[blocks.length - 1];
      if (l.indexOf('INFO WINRATE ') === 0) b.wr = parseFloat(l.slice(12));
      else if (l.indexOf('INFO BESTLINE ') === 0) b.mv = l.slice(14).trim().split(' ')[0];
    }
  }
  /* 搜索过程中会反复打印整份根节点列表，取最后一份（从最后一个 idx=0 开始） */
  var start = 0;
  for (var j = blocks.length - 1; j >= 0; j--) {
    if (blocks[j].idx === 0) { start = j; break; }
  }
  return blocks.slice(start);
}

function cellOfCoord(str) {
  if (!str) return -1;
  var parts = str.split(',');
  if (parts.length < 2) return -1;
  var x = parseInt(parts[0], 10), y = parseInt(parts[1], 10);
  if (!isFinite(x) || !isFinite(y)) return -1;
  return y * 15 + x;
}

function analyze(req) {
  LOG = [];
  var t = Math.max(120, Math.min(1500, req.timeMs || 320));
  M.sendCommand('INFO rule 4');
  M.sendCommand('INFO caution_factor 0');
  M.sendCommand('INFO show_detail 2');
  M.sendCommand('INFO timeout_turn ' + t);
  var lines = [];
  var mv = req.moves || [];
  for (var i = 0; i < mv.length; i++) {
    var cell = mv[i][0];
    lines.push((cell % 15) + ',' + Math.floor(cell / 15) + ',' + mv[i][1]);
  }
  M.sendCommand('YXBOARD\n' + (lines.length ? lines.join('\n') + '\n' : '') + 'DONE');
  /* 让引擎自己选 Top-N 好点（不传 cells → 引擎从合法空点里选） */
  var n = Math.max(4, Math.min(20, req.topN || 12));
  M.sendCommand('YXNBEST ' + n);
  var blocks = parseBlocks(LOG);
  var out = [];
  for (var k = 0; k < blocks.length; k++) {
    var b = blocks[k];
    var c = cellOfCoord(b.mv);
    if (c >= 0 && b.wr !== null && isFinite(b.wr)) out.push([c, Math.max(0, Math.min(1, b.wr))]);
  }
  return out;
}

function flush() {
  scheduled = false;
  if (!ready || !pendingReq) return;
  var req = pendingReq;
  pendingReq = null;
  var t0 = Date.now();
  var vals = [];
  try {
    vals = analyze(req);
  } catch (e) {
    send('result', vals, { id: req.id, ms: 0, error: String(e) });
    return;
  }
  send('result', vals, { id: req.id, ms: Date.now() - t0 });
}

self.onmessage = function (e) {
  var d = e.data || {};
  if (d.type === 'analyze') {
    pendingReq = d;                    /* 只保留最新请求，避免排队卡顿 */
    if (!scheduled) { scheduled = true; setTimeout(flush, 0); }
  } else if (d.type === 'ping') {
    send('pong', ready);
  }
};

/* ---------- 启动引擎 ---------- */
Rapfi({
  locateFile: function (p) { return p; },
  onReceiveStdout: function (l) { LOG.push(l); },
  onReceiveStderr: function () {},
  print: function () {},
  printErr: function () {}
}).then(function (mod) {
  M = mod;
  /* 初始化棋盘与规则（必须 START，否则引擎认为没有开局，搜索直接返回空） */
  M.sendCommand('INFO rule 4');
  M.sendCommand('INFO caution_factor 0');
  M.sendCommand('INFO show_detail 2');
  M.sendCommand('START 15');
  ready = true;
  send('status', 'ready');
}).catch(function (err) {
  failed = true;
  console.error('Rapfi init failed:', err);
  send('status', 'error', { message: String(err) });
});
