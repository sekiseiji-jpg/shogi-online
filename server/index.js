/* 本将棋 オンライン対戦サーバー（人間同士）
   - 合言葉(部屋コード)で2人が入室して対局
   - サーバ権威型：盤面をサーバが持ち、指し手は rules.js（クライアントと共有）の合法手と照合してから中継。
     詰みもサーバが判定する（クライアントからの勝敗申告は受け付けない）
   - 投了 / 再戦 / 再接続(席復帰) / 観戦 / チャット / 音声通話の中継
*/
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const R = require('../public/rules.js');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (_req, res) => res.type('text').send('ok'));
// 本番にどの版が出ているか確認用。本体を更新したらこの文字列を上げる。
const VERSION = '2026-10-05a';
app.get('/version', (_req, res) => res.type('text').send(VERSION));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });   // 巨大メッセージでメモリを使い切らせない

/** rooms[code] = {
 *   seats:[{name,token,ws|null,connected,leftAt} | null, null],
 *   spectators:Set<ws>, moves:[], state:{board,hands,turn}, turn:0, started, over, result, rematch:[false,false],
 *   voice:[false,false], lastActivity
 * } */
const rooms = new Map();
const GRACE_MS = 10 * 60 * 1000;     // 空室・切断放置の掃除猶予
const TAKEOVER_MS = Number(process.env.TAKEOVER_MS) || 3 * 60 * 1000;   // 切断した席を別の人に譲るまでの猶予（それまでは本人の復帰を待つ。テスト用に環境変数で短くできる）
// 対局中に切断したまま戻らない人は、この時間で放棄（相手の勝ち）とする。テスト用に環境変数で短くできる
const ABANDON_MS = Number(process.env.ABANDON_MS) || TAKEOVER_MS;
const MAX_MOVES = Number(process.env.MAX_MOVES) || 1000;   // 1局の手数の上限（無限に伸ばさせない。テスト用に環境変数で短くできる）
// 入室パスワード。秘密はソースに書かず環境変数で渡す（Render の ROOM_PASSWORD）。
const ROOM_PASSWORD = process.env.ROOM_PASSWORD || '';
if (!ROOM_PASSWORD) console.warn('[warn] ROOM_PASSWORD 未設定：全ての入室を拒否します。Renderの環境変数を設定してください。');

function makeToken() { return require('crypto').randomBytes(16).toString('hex'); }
function newState() { return { board: R.initBoard(), hands: [{}, {}], turn: 0 }; }
function roomRoster(room){
  return {
    names: [room.seats[0]?.name || null, room.seats[1]?.name || null],
    connected: [!!room.seats[0]?.connected, !!room.seats[1]?.connected],
    spectators: room.spectators.size
  };
}
function sendTo(ws, obj){ try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch(_){} }
function broadcast(room, obj, exceptWs){
  for (const s of room.seats) if (s && s.ws && s.ws !== exceptWs) sendTo(s.ws, obj);
  for (const sp of room.spectators) if (sp !== exceptWs) sendTo(sp, obj);
}
function pushRoster(room){ broadcast(room, { type:'players', ...roomRoster(room) }); }
function syncMsg(room, ws){
  return { type:'sync', moves:room.moves, turn:room.turn, started:room.started, over:room.over, result:room.result, yourSeat: ws.meta.seat };
}

// クライアントから来た手を、サーバの局面の合法手と照合する。一致した合法手（サーバ側で作ったもの）を返す。不正なら null
function findLegal(room, seat, mv){
  if (!mv || typeof mv !== 'object') return null;
  const legal = R.legalMoves(room.state, seat);
  return legal.find(m => m.drop === !!mv.drop && m.tr === mv.tr && m.tc === mv.tc && m.promote === !!mv.promote &&
    (m.drop ? m.fc === mv.fc : (m.fr === mv.fr && m.fc === mv.fc))) || null;
}

// その接続が今いる部屋から抜ける（別の部屋・同じ部屋への再 join の前に呼ぶ）
function detach(ws){
  const room = ws.meta.room ? rooms.get(ws.meta.room) : null;
  if (!room) { ws.meta.room = null; ws.meta.seat = null; return; }
  const seat = ws.meta.seat;
  if (seat === 'spec') room.spectators.delete(ws);
  else if (seat === 0 || seat === 1) {
    const s = room.seats[seat];
    if (s && s.ws === ws) { s.connected = false; s.ws = null; s.leftAt = Date.now(); }
    room.rematch[seat] = false;   // 切断したら再戦の希望は取り消す（席が人に渡った後も残っていた）
    if (room.voice && room.voice[seat]) { room.voice[seat] = false; const o = room.seats[seat^1]; if (o && o.ws) sendTo(o.ws, { type:'voice', sub:'leave', fromSeat:seat }); }
    broadcast(room, { type:'left', seat });
  }
  room.lastActivity = Date.now();
  ws.meta.room = null; ws.meta.seat = null;
  pushRoster(room);
}

function cleanupRooms(){
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyConn = room.seats.some(s => s && s.connected) || room.spectators.size > 0;
    if (!anyConn && now - room.lastActivity > GRACE_MS) rooms.delete(code);
  }
}
setInterval(cleanupRooms, 60 * 1000);

// 放棄の判定：対局中、一方が ABANDON_MS 以上切断したままで、もう一方が接続していれば、接続している側の勝ち。
// 両方切断している時は判定しない（どちらかが戻るのを待つ。部屋は cleanupRooms が片付ける）
function checkAbandon(){
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.started || room.over) continue;
    for (let i=0;i<2;i++) {
      const s = room.seats[i], o = room.seats[i^1];
      if (s && !s.connected && now - (s.leftAt || 0) >= ABANDON_MS && o && o.connected) {
        room.over = true;
        room.result = { reason:'abandon', winner: i ^ 1, draw:false };
        broadcast(room, { type:'end', ...room.result });
        break;
      }
    }
  }
}
setInterval(checkAbandon, Math.max(200, Math.min(5000, ABANDON_MS / 4)));

function onJoin(ws, msg){
  // パスワード認証（未設定なら誰も入室不可＝フェイルクローズ）
  if (!ROOM_PASSWORD || String(msg.password || '') !== ROOM_PASSWORD) {
    return sendTo(ws, { type:'error', msg:'パスワードが違います' });
  }
  const code = String(msg.room || '').trim().slice(0, 40);
  const name = String(msg.name || '対局者').trim().slice(0, 20) || '対局者';
  if (!code) return sendTo(ws, { type:'error', msg:'合言葉を入力してください' });
  if (ws.meta.room) detach(ws);   // 同じ接続で入り直した時に前の席を残さない
  let r = rooms.get(code);
  if (!r) { r = { seats:[null,null], spectators:new Set(), moves:[], state:newState(), turn:0, started:false, over:false, result:null, rematch:[false,false], voice:[false,false], lastActivity:Date.now() }; rooms.set(code, r); }
  r.lastActivity = Date.now();

  // 1) 再接続：token が一致すれば、その席に戻る。サーバがまだ切断に気付いていない（半開き）古い接続は切る。
  //    ただし、その席の接続が生きている（ping に応答している）なら奪わない。奪い合うと、切られた側が自動再接続して
  //    切り返し、同じブラウザで2つ開いただけで無限に切断・再接続を繰り返してしまう（2026-10-03 修正）
  let seat = null;
  const tok = typeof msg.seatToken === 'string' ? msg.seatToken : null;
  if (tok) {
    for (let i=0;i<2;i++) {
      const s = r.seats[i];
      if (s && s.token === tok) {
        if (s.ws && s.ws !== ws) {
          // 席は新しい接続に渡すが、切られる側には理由を伝えてから切る。
          // fatal を受けたクライアントは自動再接続しないので、2つのタブが交互に切り合う無限ループにならない
          sendTo(s.ws, { type:'error', fatal:true, msg:'同じ席に別のタブ（または端末）から入室したため、この画面は切断されました' });
          try { s.ws.meta.room = null; setTimeout(()=>{ try{ s.ws.terminate(); }catch(_){} }, 50); } catch(_){}
        }
        seat = i; break;
      }
    }
  }
  // 2) 空席：まだ誰も座っていない席。切断した人の席は、しばらく本人の復帰を待ってから譲る（乗っ取り防止）
  if (seat === null) {
    for (let i=0;i<2;i++) if (!r.seats[i]) { seat = i; break; }
  }
  if (seat === null) {
    const now = Date.now();
    for (let i=0;i<2;i++) { const s = r.seats[i]; if (s && !s.connected && now - (s.leftAt || 0) > TAKEOVER_MS) { r.seats[i] = null; seat = i; break; } }
  }

  ws.meta.room = code;
  if (seat === null) { // 満席 → 観戦
    ws.meta.seat = 'spec';
    r.spectators.add(ws);
    sendTo(ws, { type:'joined', seat:'spectator', room:code });
  } else {
    const prev = r.seats[seat];
    const reconnect = !!(prev && prev.token === tok);
    const token = reconnect ? prev.token : makeToken();   // 別人が座る時は新しい token
    r.seats[seat] = { name, token, ws, connected:true, leftAt:0 };
    ws.meta.seat = seat;
    if (!reconnect) {
      r.rematch[seat] = false;   // 前の人の「再戦希望」を引き継がない
      // 終わった対局が残っている部屋に新しい人が座ったら、その対局は片付けて次の開始を待つ
      // （以前は started が false に戻らず、無関係な2人が他人の終局結果を見せられていた）
      if (r.over) { r.started = false; r.over = false; r.result = null; r.moves = []; r.state = newState(); r.turn = 0; r.rematch = [false,false]; }
    }
    sendTo(ws, { type:'joined', seat, room:code, seatToken:token, name });
  }
  // 満席になったら開始（開始の通知は開始した時の1回だけ。入室のたびに送ると終局表示が消えていた）
  let justStarted = false;
  if (!r.started && r.seats[0] && r.seats[0].connected && r.seats[1] && r.seats[1].connected) {
    r.started = true; r.over = false; r.turn = 0; r.moves = []; r.state = newState(); justStarted = true;
  }
  // 現状同期（観戦・再接続時に既存の手と結果を渡す）
  sendTo(ws, syncMsg(r, ws));
  pushRoster(r);
  if (justStarted) broadcast(r, { type:'start' });
}

function onMessage(ws, msg){
  if (msg.type === 'join') return onJoin(ws, msg);

  const room = ws.meta.room ? rooms.get(ws.meta.room) : null;
  if (!room) return;
  room.lastActivity = Date.now();
  const seat = ws.meta.seat;
  const isPlayer = (seat === 0 || seat === 1);

  if (msg.type === 'move') {
    if (!isPlayer) return;   // 観戦者は不可
    if (!room.started || room.over) return;
    if (seat !== room.turn) return sendTo(ws, { type:'error', msg:'あなたの手番ではありません' });
    const mv = findLegal(room, seat, msg.mv);
    if (!mv) { sendTo(ws, { type:'error', msg:'その手は指せません' }); return sendTo(ws, syncMsg(room, ws)); }   // 不正な手は局面を送り直して揃える
    if (room.moves.length >= MAX_MOVES) {   // 上限に達したら、黙って捨てずに知らせて局面を揃える
      sendTo(ws, { type:'error', msg:'この対局は手数の上限に達しました' });
      return sendTo(ws, syncMsg(room, ws));
    }
    R.applyMove(room.state, mv);
    room.moves.push(mv);
    room.turn = room.state.turn;
    broadcast(room, { type:'move', mv, seat }, ws); // 打った本人以外へ（本人は適用済み）
    // 詰みはサーバが判定（相手に合法手が無い）
    if (R.legalMoves(room.state, room.turn).length === 0) {
      room.over = true;
      room.result = { reason:'checkmate', winner: seat, draw:false };
      broadcast(room, { type:'end', ...room.result });
    }
    return;
  }
  // 'end'（クライアントからの勝敗申告）は受け付けない。詰みはサーバが判定し、投了は 'resign' で行う
  if (msg.type === 'resign') {
    if (!isPlayer || !room.started || room.over) return;
    room.over = true;
    room.result = { reason:'resign', winner: seat ^ 1, draw:false };
    broadcast(room, { type:'end', ...room.result });
    return;
  }
  if (msg.type === 'rematch') {
    if (!isPlayer || !room.over) return;   // 再戦は終局後だけ
    room.rematch[seat] = true;
    broadcast(room, { type:'rematchWanted', seat });
    if (room.rematch[0] && room.rematch[1]) {
      room.moves = []; room.state = newState(); room.turn = 0; room.over = false; room.result = null; room.rematch = [false,false]; room.started = true;
      broadcast(room, { type:'restart' });
    }
    return;
  }
  if (msg.type === 'voice') {
    // 通話は対局者2人のみ。観戦者は不可。シグナリングは相手席にだけ中継（観戦者へは絶対に流さない）
    if (!isPlayer) return;
    if (!room.voice) room.voice = [false, false];
    const other = seat ^ 1;
    const otherWs = (room.seats[other] && room.seats[other].connected) ? room.seats[other].ws : null;
    if (msg.sub === 'join') {
      room.voice[seat] = true;
      if (otherWs) sendTo(otherWs, { type:'voice', sub:'join', fromSeat:seat });
      if (room.voice[other]) sendTo(ws, { type:'voice', sub:'join', fromSeat:other }); // 相手が既に通話中なら双方に通知
    } else if (msg.sub === 'leave') {
      room.voice[seat] = false;
      if (otherWs) sendTo(otherWs, { type:'voice', sub:'leave', fromSeat:seat });
    } else if (msg.sub === 'signal') {
      if (otherWs) sendTo(otherWs, { type:'voice', sub:'signal', fromSeat:seat, signal: msg.signal });
    }
    return;
  }
  if (msg.type === 'chat') {
    const text = String(msg.text || '').slice(0, 200);
    if (!text) return;
    const nm = isPlayer ? (room.seats[seat]?.name || '対局者') : '観戦者';
    broadcast(room, { type:'chat', name:nm, text });
    return;
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.meta = { room: null, seat: null }; // seat: 0|1|'spec'

  ws.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;   // null や数値だけのメッセージで落ちないように
    // 1通の不正メッセージでプロセスごと落ちて全対局が消えないよう、処理中の例外はここで止める
    try { onMessage(ws, msg); } catch (e) { console.error('[ws] message error:', msg.type, e && e.stack || e); }
  });

  ws.on('close', () => {
    try { detach(ws); } catch (e) { console.error('[ws] close error:', e && e.stack || e); }
  });
});

// WSキープアライブ（プロキシのアイドル切断対策）
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false; try { ws.ping(); } catch(_){}
  });
}, 30000);

// 最後の砦：想定外の例外でも全対局を道連れにしない（ログだけ残して継続）
process.on('uncaughtException', (e) => { console.error('[uncaught]', e && e.stack || e); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('shogi-online listening on', PORT));
