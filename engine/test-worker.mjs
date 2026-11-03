// 模拟主线程：先 analyze 开局 → 等 500ms → 再 analyze 新落子（模拟用户点了一下）
// 看 Worker 能不能及时切到新局面
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const worker = new Worker(join(dirname(fileURLToPath(import.meta.url)), 'rapfi-worker.js'));

let seq = 0;
let lastState = null;

worker.on('message', (m) => {
  const elapsed = Date.now() - startT;
  if (m.type === 'status') {
    console.log(`[${elapsed}ms] status: ${m.data}`);
    if (m.data === 'ready') {
      // 发第一个 analyze（开局空棋盘）
      const s1 = ++seq;
      console.log(`\n→ send analyze id=${s1} (empty board)`);
      worker.postMessage({ type: 'analyze', id: s1, moves: [], topN: 10 });
      
      // 模拟用户 800ms 后落子
      setTimeout(() => {
        const s2 = ++seq;
        console.log(`\n→ send analyze id=${s2} (black at 7,7) ← 模拟落子`);
        worker.postMessage({ type: 'analyze', id: s2, moves: [[7*15+7, 1]], topN: 10 });
        
        // 再模拟 800ms 后白棋落子
        setTimeout(() => {
          const s3 = ++seq;
          console.log(`\n→ send analyze id=${s3} (black 7,7 + white 8,7)`);
          worker.postMessage({ type: 'analyze', id: s3, moves: [[7*15+7, 1], [8*15+7, 2]], topN: 10 });
        }, 800);
      }, 800);
    }
  } else if (m.type === 'progress') {
    const wrs = m.data.slice(0, 5).map(x => (x[1]*100).toFixed(1)+'%').join(',');
    console.log(`[${elapsed}ms] progress id=${m.id} round=${m.round} ms=${m.ms} wr=[${wrs}]`);
  } else if (m.type === 'result') {
    const wrs = m.data.slice(0, 5).map(x => (x[1]*100).toFixed(1)+'%').join(',');
    console.log(`[${elapsed}ms] RESULT id=${m.id} round=${m.round} ms=${m.ms} wr=[${wrs}]`);
    // 等第三个 result 后杀掉
    if (m.id >= seq) {
      setTimeout(() => { console.log('\n✓ 测试完成'); process.exit(0); }, 500);
    }
  }
});

const startT = Date.now();

setTimeout(() => { console.log('timeout, killing'); process.exit(1); }, 15000);
