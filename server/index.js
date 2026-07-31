/* 本将棋 オンライン対戦サーバー（人間同士）
   - 合言葉(部屋コード)で2人が入室して対局
   - 手番管理つきで指し手を相手へ中継（将棋ルールの合否はクライアント側で判定）
   - 投了 / 再戦 / 再接続(席復帰) / 観戦 / チャット
*/
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (_req, res) => res.type('text').send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/** rooms[code] = {
 *   seats:[{name,token,ws|null,connected} | null, null],
 *   spectators:Set<ws>, moves:[], turn:0, started, over, result, rematch:[false,false],
 *   lastActivity
 * } */
const rooms = new Map();
const GRACE_MS = 10 * 60 * 1000;   // 空室・切断放置の掃除猶予

function makeToken() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
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

function cleanupRooms(){
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyConn = room.seats.some(s => s && s.connected) || room.spectators.size > 0;
    if (!anyConn && now - room.lastActivity > GRACE_MS) rooms.delete(code);
  }
}
setInterval(cleanupRooms, 60 * 1000);

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.meta = { room: null, seat: null }; // seat: 0|1|'spec'

  ws.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    const room = ws.meta.room ? rooms.get(ws.meta.room) : null;

    if (msg.type === 'join') {
      const code = String(msg.room || '').trim().slice(0, 40);
      const name = String(msg.name || '対局者').trim().slice(0, 20) || '対局者';
      if (!code) return sendTo(ws, { type:'error', msg:'合言葉を入力してください' });
      let r = rooms.get(code);
      if (!r) { r = { seats:[null,null], spectators:new Set(), moves:[], turn:0, started:false, over:false, result:null, rematch:[false,false], voice:[false,false], lastActivity:Date.now() }; rooms.set(code, r); }
      r.lastActivity = Date.now();

      // 再接続（token一致の「切断中」の席だけ復帰。接続中の席は奪わない）
      let seat = null;
      const tok = msg.seatToken;
      if (tok) { for (let i=0;i<2;i++) if (r.seats[i] && r.seats[i].token===tok && !r.seats[i].connected) { seat=i; break; } }
      if (seat === null) { // 空席を探す
        for (let i=0;i<2;i++) if (!r.seats[i] || !r.seats[i].connected) { seat=i; break; }
      }

      ws.meta.room = code;
      if (seat === null) { // 満席 → 観戦
        ws.meta.seat = 'spec';
        r.spectators.add(ws);
        sendTo(ws, { type:'joined', seat:'spectator', room:code });
      } else {
        const token = (r.seats[seat] && r.seats[seat].token) || makeToken();
        r.seats[seat] = { name, token, ws, connected:true };
        ws.meta.seat = seat;
        sendTo(ws, { type:'joined', seat, room:code, seatToken:token, name });
      }
      // 満席になったら開始
      if (!r.started && r.seats[0] && r.seats[0].connected && r.seats[1] && r.seats[1].connected) {
        r.started = true; r.over = false; r.turn = 0; if (!r.moves) r.moves = [];
      }
      // 現状同期（観戦・再接続時に既存の手を渡す）
      sendTo(ws, { type:'sync', moves:r.moves, turn:r.turn, started:r.started, over:r.over, result:r.result, yourSeat: ws.meta.seat });
      pushRoster(r);
      if (r.started) broadcast(r, { type:'start' });
      return;
    }

    if (!room) return;
    room.lastActivity = Date.now();
    const seat = ws.meta.seat;

    if (msg.type === 'move') {
      if (seat !== 0 && seat !== 1) return; // 観戦者は不可
      if (!room.started || room.over) return;
      if (seat !== room.turn) return sendTo(ws, { type:'error', msg:'あなたの手番ではありません' });
      const mv = msg.mv;
      room.moves.push(mv);
      room.turn ^= 1;
      broadcast(room, { type:'move', mv, seat }, ws); // 打った本人以外へ
      return;
    }
    if (msg.type === 'end') { // クライアントが詰み/千日手を検出
      if (room.over) return;
      room.over = true;
      room.result = { reason: msg.reason || 'end', winner: (typeof msg.winner==='number'?msg.winner:null), draw: !!msg.draw };
      broadcast(room, { type:'end', ...room.result });
      return;
    }
    if (msg.type === 'resign') {
      if (seat !== 0 && seat !== 1 || room.over) return;
      room.over = true;
      room.result = { reason:'resign', winner: seat ^ 1, draw:false };
      broadcast(room, { type:'end', ...room.result });
      return;
    }
    if (msg.type === 'rematch') {
      if (seat !== 0 && seat !== 1) return;
      room.rematch[seat] = true;
      broadcast(room, { type:'rematchWanted', seat });
      if (room.rematch[0] && room.rematch[1]) {
        room.moves = []; room.turn = 0; room.over = false; room.result = null; room.rematch = [false,false]; room.started = true;
        broadcast(room, { type:'restart' });
      }
      return;
    }
    if (msg.type === 'voice') {
      // 通話は対局者2人のみ。観戦者は不可。シグナリングは相手席にだけ中継（観戦者へは絶対に流さない）
      if (seat !== 0 && seat !== 1) return;
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
      const nm = (seat===0||seat===1) ? (room.seats[seat]?.name || '対局者') : '観戦者';
      broadcast(room, { type:'chat', name:nm, text });
      return;
    }
  });

  ws.on('close', () => {
    const room = ws.meta.room ? rooms.get(ws.meta.room) : null;
    if (!room) return;
    const seat = ws.meta.seat;
    if (seat === 'spec') { room.spectators.delete(ws); }
    else if (seat === 0 || seat === 1) {
      if (room.seats[seat] && room.seats[seat].ws === ws) { room.seats[seat].connected = false; room.seats[seat].ws = null; }
      if (room.voice && room.voice[seat]) { room.voice[seat] = false; const o = room.seats[seat^1]; if (o && o.ws) sendTo(o.ws, { type:'voice', sub:'leave', fromSeat:seat }); }
      broadcast(room, { type:'left', seat });
    }
    room.lastActivity = Date.now();
    pushRoster(room);
  });
});

// WSキープアライブ（プロキシのアイドル切断対策）
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false; try { ws.ping(); } catch(_){}
  });
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('shogi-online listening on', PORT));
