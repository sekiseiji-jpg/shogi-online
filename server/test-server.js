'use strict';
// オンライン対戦サーバの結合テスト。実際にサーバを起動し、WebSocket クライアントで操作して確かめる。
//   不正メッセージで落ちない / パスワード / サーバ権威（不正な手の拒否・勝敗申告の無視・詰みの判定）/
//   席の乗っ取り防止と token での復帰 / 観戦者の入室で終局表示が消えない / 再戦は終局後だけ / 投了 / 切断が続いた時の放棄
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const R = require('../public/rules.js');

const PORT = 3900 + Math.floor(Math.random() * 90);
const PASS = 'test-pass';
let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '✅' : '❌') + ' ' + name + ' => ' + JSON.stringify(got) + (ok ? '' : ' (want ' + JSON.stringify(want) + ')'));
  ok ? pass++ : fail++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client() {
  const ws = new WebSocket('ws://127.0.0.1:' + PORT);
  const msgs = [];
  ws.on('message', d => { try { msgs.push(JSON.parse(d.toString())); } catch (_) {} });
  const c = {
    ws, msgs,
    open: () => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
    send: o => ws.send(typeof o === 'string' ? o : JSON.stringify(o)),
    mark: () => msgs.length,
    // type のメッセージが来るまで待つ（pred で絞り込み可）。from 以降に届いたものを対象にする（既定は呼んだ時点以降）
    wait: (type, pred = () => true, ms = 2000, from) => new Promise((res) => {
      const start = from === undefined ? msgs.length : from; const t0 = Date.now();
      (function poll() {
        const m = msgs.slice(start).find(x => x.type === type && pred(x));
        if (m) return res(m);
        if (Date.now() - t0 > ms) return res(null);
        setTimeout(poll, 20);
      })();
    }),
    last: type => [...msgs].reverse().find(x => x.type === type) || null,
    close: () => new Promise(res => { ws.once('close', res); ws.close(); }),
  };
  return c;
}
function health() {
  return new Promise(res => {
    http.get('http://127.0.0.1:' + PORT + '/health', r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(b)); })
      .on('error', () => res(null));
  });
}
// 盤座標の手 {fr,fc,tr,tc}（先手 ☗7六歩 = [6,2]->[5,2]）
const mv = (fr, fc, tr, tc) => ({ fr, fc, tr, tc, promote: false, drop: false });

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, 'index.js')], { env: { ...process.env, PORT: String(PORT), ROOM_PASSWORD: PASS, ABANDON_MS: '1500' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvErr = ''; srv.stderr.on('data', d => srvErr += d);
  for (let i = 0; i < 50 && !(await health()); i++) await sleep(100);

  try {
    // ---- 不正なメッセージで落ちない ----
    {
      const x = client(); await x.open();
      x.send('null'); x.send('123'); x.send('"str"'); x.send('{"type":5}'); x.send('{bad json');
      x.send({ type: 'move', mv: null }); x.send({ type: 'end', winner: 0 });   // 入室前
      await sleep(200);
      check('null などを送ってもサーバは生きている', await health(), 'ok');
      await x.close();
    }
    // ---- パスワード ----
    {
      const x = client(); await x.open();
      x.send({ type: 'join', room: 'r1', name: 'x', password: 'wrong' });
      const e = await x.wait('error');
      check('パスワード違いは入室不可', e && e.msg, 'パスワードが違います');
      await x.close();
    }
    // ---- 2人入室して開始 ----
    const a = client(), b = client(); await a.open(); await b.open();
    a.send({ type: 'join', room: 'r2', name: 'A', password: PASS });
    const ja = await a.wait('joined');
    b.send({ type: 'join', room: 'r2', name: 'B', password: PASS });
    const jb = await b.wait('joined');
    check('先に入った人が先手、次が後手', [ja && ja.seat, jb && jb.seat], [0, 1]);
    check('2人そろうと開始', !!(await a.wait('start', () => true, 500) || a.last('start')), true);

    // ---- サーバ権威：不正な手は拒否して局面を送り直す ----
    const m1 = a.mark();
    a.send({ type: 'move', mv: mv(6, 2, 3, 2) });   // 歩を3マス進める（不正）
    const err1 = await a.wait('error', undefined, undefined, m1);
    const sy1 = await a.wait('sync', undefined, undefined, m1);
    check('不正な手は拒否', err1 && err1.msg, 'その手は指せません');
    check('拒否したら局面を送り直す（手は0のまま）', sy1 && sy1.moves.length, 0);
    check('相手には不正な手が届かない', b.msgs.filter(m => m.type === 'move').length, 0);
    a.send({ type: 'move', mv: { fr: -1, fc: '__proto__', tr: 4, tc: 4, drop: true } });   // 持っていない駒を打つ
    check('捏造した打ち駒も拒否', (await a.wait('error')) && true, true);
    b.send({ type: 'move', mv: mv(2, 6, 3, 6) });   // 後手が先手番に指す
    check('手番でない人の手は拒否', (await b.wait('error')) && b.last('error').msg, 'あなたの手番ではありません');

    // 正しい手は相手に届く（サーバが作った合法手の形で）
    a.send({ type: 'move', mv: mv(6, 2, 5, 2) });   // ☗7六歩
    const bm = await b.wait('move');
    check('正しい手は相手に届く', bm && [bm.mv.fr, bm.mv.fc, bm.mv.tr, bm.mv.tc, bm.mv.drop], [6, 2, 5, 2, false]);

    // ---- 勝敗の申告（'end'）は受け付けない ----
    b.send({ type: 'end', reason: 'checkmate', winner: 1 });
    await sleep(150);
    check("クライアントからの 'end' は無視", a.msgs.filter(m => m.type === 'end').length, 0);

    // ---- 観戦者が入っても 'start' を送り直さない（終局表示が消えていた件）----
    const sp = client(); await sp.open();
    const startsBefore = a.msgs.filter(m => m.type === 'start').length;
    sp.send({ type: 'join', room: 'r2', name: 'S', password: PASS });
    const jsp = await sp.wait('joined');
    await sleep(150);
    check('3人目は観戦', jsp && jsp.seat, 'spectator');
    check('観戦者の入室で start は送られない', a.msgs.filter(m => m.type === 'start').length, startsBefore);
    sp.send({ type: 'end', winner: 0 }); sp.send({ type: 'resign' }); sp.send({ type: 'move', mv: mv(2, 6, 3, 6) });
    await sleep(150);
    check('観戦者は投了・着手・勝敗申告できない', [a.msgs.filter(m => m.type === 'end').length, b.msgs.filter(m => m.type === 'move').length], [0, 1]);

    // ---- 再戦は終局後だけ ----
    a.send({ type: 'rematch' }); b.send({ type: 'rematch' });
    await sleep(150);
    check('対局中の再戦申し込みは無視', a.msgs.filter(m => m.type === 'restart' || m.type === 'rematchWanted').length, 0);

    // ---- 切断中の席を他人が乗っ取れない／token で本人は戻れる ----
    const tokenA = ja.seatToken;
    await a.close();
    await sleep(150);
    const intr = client(); await intr.open();
    intr.send({ type: 'join', room: 'r2', name: 'X', password: PASS });
    const ji = await intr.wait('joined');
    check('切断直後の席は第三者に渡らない（観戦になる）', ji && ji.seat, 'spectator');
    const a2 = client(); await a2.open();
    a2.send({ type: 'join', room: 'r2', name: 'A', password: PASS, seatToken: tokenA });
    const ja2 = await a2.wait('joined', undefined, undefined, 0);
    const sy2 = await a2.wait('sync', undefined, undefined, 0);
    check('token で自分の席に戻れる', ja2 && [ja2.seat, ja2.seatToken === tokenA], [0, true]);
    check('戻ると指し手が同期される', sy2 && sy2.moves.length, 1);

    // ---- 投了 ----
    b.send({ type: 'move', mv: mv(2, 6, 3, 6) });   // ☖3四歩
    await a2.wait('move');
    a2.send({ type: 'resign' });
    const ea = await b.wait('end');
    check('投了で相手の勝ち', ea && [ea.reason, ea.winner], ['resign', 1]);
    // 終局後に入り直しても結果が届く
    const a3 = client(); await a3.open();
    a3.send({ type: 'join', room: 'r2', name: 'A', password: PASS, seatToken: tokenA });
    const sy3 = await a3.wait('sync');
    check('終局後の同期に結果が入る', sy3 && [sy3.over, sy3.result && sy3.result.reason], [true, 'resign']);
    // 終局後の再戦
    a3.send({ type: 'rematch' }); b.send({ type: 'rematch' });
    check('終局後は再戦できる', !!(await b.wait('restart')), true);

    // ---- 詰みはサーバが判定：ルール側の詰み判定を確認 ----
    {
      const e = () => Array.from({ length: 9 }, () => Array(9).fill(null));
      const st = { board: e(), hands: [{}, {}], turn: 1 };
      st.board[0][4] = { t: 'K', o: 1, p: false };   // 後手玉 5一
      st.board[1][4] = { t: 'G', o: 0, p: false };   // 先手金 5二
      st.board[2][4] = { t: 'S', o: 0, p: false };   // 先手銀 5三（金に紐）
      st.board[8][4] = { t: 'K', o: 0, p: false };
      check('頭金は詰み（合法手0）', R.legalMoves(st, 1).length, 0);
      st.board[2][4] = null;                          // 紐がなければ玉で取れる
      check('紐のない頭金は詰まない', R.legalMoves(st, 1).length > 0, true);
    }

    // ---- 放棄：対局中に切断したまま戻らない人は負け（テストでは ABANDON_MS=1500）----
    {
      const p = client(), q = client(); await p.open(); await q.open();
      p.send({ type: 'join', room: 'r3', name: 'P', password: PASS }); await p.wait('joined');
      q.send({ type: 'join', room: 'r3', name: 'Q', password: PASS }); await q.wait('joined');
      await q.wait('start', () => true, 500, 0);
      await p.close();
      const early = await q.wait('end', () => true, 800, 0);
      check('切断してすぐは放棄にならない', early, null);
      const ab = await q.wait('end', () => true, 3000, 0);
      check('切断が続くと放棄で相手の勝ち', ab && [ab.reason, ab.winner], ['abandon', 1]);
      q.ws.close();
    }

    for (const c of [b, sp, intr, a2, a3]) { try { c.ws.close(); } catch (_) {} }
    await sleep(100);
    check('最後までサーバが落ちていない', await health(), 'ok');
    check('サーバの例外ログなし', srvErr.includes('[uncaught]') || srvErr.includes('message error'), false);
  } finally {
    srv.kill();
  }
  console.log('\n' + (fail === 0 ? '🎉 all passed' : `⚠ ${fail} failed`) + ` (${pass}/${pass + fail})`);
  process.exit(fail === 0 ? 0 : 1);
})();
