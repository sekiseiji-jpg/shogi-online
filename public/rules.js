/* 本将棋 オンライン対戦：ルールエンジン（クライアントとサーバで共有）
   - ブラウザ: <script src="rules.js"> でグローバル関数として読み込む
   - サーバ:   require('../public/rules.js') で同じ関数を使い、指し手の合法性と詰みをサーバ側で判定する
   ルールを二重に実装しないため、ここだけを直せば両方に効く。 */
const KANJI={K:{n:'玉',p:null},R:{n:'飛',p:'龍'},B:{n:'角',p:'馬'},G:{n:'金',p:null},S:{n:'銀',p:'成銀'},N:{n:'桂',p:'成桂'},L:{n:'香',p:'成香'},P:{n:'歩',p:'と'}};
const KING_LABEL={0:'王',1:'玉'};
const STEP={G:[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,0]],S:[[-1,-1],[-1,0],[-1,1],[1,-1],[1,1]],K:[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]],N:[[-2,-1],[-2,1]],P:[[-1,0]]};
const GOLD=STEP.G;
const SLIDE={R:[[-1,0],[1,0],[0,-1],[0,1]],B:[[-1,-1],[-1,1],[1,-1],[1,1]],L:[[-1,0]]};
function initBoard(){const b=Array.from({length:9},()=>Array(9).fill(null));const back=['L','N','S','G','K','G','S','N','L'];
  for(let c=0;c<9;c++){b[0][c]={t:back[c],o:1,p:false};b[2][c]={t:'P',o:1,p:false};b[8][c]={t:back[c],o:0,p:false};b[6][c]={t:'P',o:0,p:false};}
  b[7][7]={t:'R',o:0,p:false};b[7][1]={t:'B',o:0,p:false};b[1][1]={t:'R',o:1,p:false};b[1][7]={t:'B',o:1,p:false};return b;}
function inZone(r,o){return o===0?r<=2:r>=6;}
function lastRow(r,o){return o===0?r===0:r===8;}
function mustPromote(pc,r){if(pc.p)return false;if(pc.t==='P'||pc.t==='L')return lastRow(r,pc.o);if(pc.t==='N')return pc.o===0?r<=1:r>=7;return false;}
function canPromote(pc,fr,tr){if(pc.p)return false;if(pc.t==='K'||pc.t==='G')return false;return inZone(fr,pc.o)||inZone(tr,pc.o);}
function pieceMoves(b,r,c){const pc=b[r][c],res=[],o=pc.o,dm=o===0?1:-1;
  const add=(nr,nc)=>{if(nr<0||nr>8||nc<0||nc>8)return false;const t=b[nr][nc];if(t&&t.o===o)return false;res.push([nr,nc]);return !t;};
  let sl=null,sd=null;
  if(pc.p){if(pc.t==='R'){sd=SLIDE.R;sl=[[-1,-1],[-1,1],[1,-1],[1,1]];}else if(pc.t==='B'){sd=SLIDE.B;sl=[[-1,0],[1,0],[0,-1],[0,1]];}else sl=GOLD;}
  else{if(pc.t==='R')sd=SLIDE.R;else if(pc.t==='B')sd=SLIDE.B;else if(pc.t==='L')sd=SLIDE.L;else sl=STEP[pc.t];}
  if(sl)for(const[dr,dc]of sl)add(r+dr*dm,c+dc);
  if(sd)for(const[dr,dc]of sd){let nr=r,nc=c;while(true){nr+=dr*dm;nc+=dc;if(!add(nr,nc))break;}}
  return res;}
function findKing(b,o){for(let r=0;r<9;r++)for(let c=0;c<9;c++){const p=b[r][c];if(p&&p.t==='K'&&p.o===o)return[r,c];}return null;}
function inCheck(b,o){const k=findKing(b,o);if(!k)return true;const[kr,kc]=k;
  for(let r=0;r<9;r++)for(let c=0;c<9;c++){const p=b[r][c];if(p&&p.o!==o)for(const[mr,mc]of pieceMoves(b,r,c))if(mr===kr&&mc===kc)return true;}return false;}
function pushOpts(res,b,r,c,tr,tc){const pc=b[r][c];const f=mustPromote(pc,tr),cp=canPromote(pc,r,tr);
  if(f)res.push({fr:r,fc:c,tr,tc,promote:true,drop:false});
  else if(cp){res.push({fr:r,fc:c,tr,tc,promote:true,drop:false});res.push({fr:r,fc:c,tr,tc,promote:false,drop:false});}
  else res.push({fr:r,fc:c,tr,tc,promote:false,drop:false});}
function genMoves(st,o){const b=st.board,mv=[];
  for(let r=0;r<9;r++)for(let c=0;c<9;c++){const pc=b[r][c];if(!pc||pc.o!==o)continue;for(const[tr,tc]of pieceMoves(b,r,c))pushOpts(mv,b,r,c,tr,tc);}
  const hand=st.hands[o],types=Object.keys(hand).filter(t=>hand[t]>0);
  if(types.length){const pcol=Array(9).fill(false);
    for(let r=0;r<9;r++)for(let c=0;c<9;c++){const p=b[r][c];if(p&&p.o===o&&p.t==='P'&&!p.p)pcol[c]=true;}
    for(let r=0;r<9;r++)for(let c=0;c<9;c++){if(b[r][c])continue;for(const t of types){
      if((t==='P'||t==='L')&&lastRow(r,o))continue;if(t==='N'&&(o===0?r<=1:r>=7))continue;if(t==='P'&&pcol[c])continue;
      mv.push({fr:-1,fc:t,tr:r,tc:c,promote:false,drop:true});}}}
  return mv;}
function clone(st){return{board:st.board.map(r=>r.map(c=>c?{t:c.t,o:c.o,p:c.p}:null)),hands:[{...st.hands[0]},{...st.hands[1]}],turn:st.turn};}
function applyMove(st,mv){const b=st.board,o=st.turn;
  if(mv.drop){b[mv.tr][mv.tc]={t:mv.fc,o,p:false};st.hands[o][mv.fc]--;}
  else{const pc=b[mv.fr][mv.fc],cap=b[mv.tr][mv.tc];if(cap)st.hands[o][cap.t]=(st.hands[o][cap.t]||0)+1;
    b[mv.tr][mv.tc]={t:pc.t,o:pc.o,p:pc.p||mv.promote};b[mv.fr][mv.fc]=null;}
  st.turn=o^1;}
function capturesKing(st,mv){if(mv.drop)return false;const t=st.board[mv.tr][mv.tc];return !!(t&&t.t==='K');}
function legalMoves(st,o){const res=[];for(const mv of genMoves(st,o)){if(capturesKing(st,mv))continue;const s=clone(st);s.turn=o;applyMove(s,mv);
  if(!inCheck(s.board,o)){if(mv.drop&&mv.fc==='P'&&dropPawnMate(st,mv,o))continue;res.push(mv);}}return res;}
function legalNoDP(st,o){const res=[];for(const mv of genMoves(st,o)){if(capturesKing(st,mv))continue;const s=clone(st);s.turn=o;applyMove(s,mv);if(!inCheck(s.board,o))res.push(mv);}return res;}
function dropPawnMate(st,mv,o){const s=clone(st);s.turn=o;applyMove(s,mv);const opp=o^1;if(!inCheck(s.board,opp))return false;return legalNoDP(s,opp).length===0;}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { KANJI, initBoard, inZone, mustPromote, canPromote, pieceMoves, findKing, inCheck,
    genMoves, clone, applyMove, capturesKing, legalMoves, dropPawnMate };
}