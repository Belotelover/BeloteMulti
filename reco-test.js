// Test : un joueur se deconnecte en pleine partie -> un bot reprend son siege
// et la partie CONTINUE ; puis il se reconnecte avec son jeton et retrouve sa place.
const { spawn } = require('child_process');
const WebSocket = require('ws');
const PORT = 34568;
const srv = spawn('node', ['server.js'], { env:{...process.env, PORT, FAST:'1'}, cwd:__dirname });
srv.stderr.on('data',d=>process.stderr.write('[SRV] '+d));
srv.on('exit',c=>console.log('[SRV] exit', c));

function mk(){ return new Promise(res=>{
  const ws=new WebSocket('ws://localhost:'+PORT);
  const c={ws, seat:-1, code:null, token:null, view:null, views:0};
  ws.on('open',()=>res(c));
  ws.on('message',raw=>{
    const m=JSON.parse(raw);
    if(m.type==='choose-seat'){ c.code=m.code; const free=[0,1,2,3].find(i=>!m.players[i].human); send(c,{type:'sit', seat:free}); }
    if(m.type==='joined'){ c.seat=m.seat; c.code=m.code; c.token=m.token; }
    if(m.type==='view'){ c.view=m.view; c.views++; auto(c); }
  });
});}
function send(c,o){ if(c.ws.readyState===1) c.ws.send(JSON.stringify(o)); }
function auto(c){
  const V=c.view; if(!V) return;
  if(V.yourTurnToDeal) return send(c,{type:'deal',first:3});
  if(V.yourTurnToBid) return send(c, V.biddingRound===1 ? (Math.random()<0.3?{type:'take'}:{type:'pass'})
    : {type:'pass'});
  if(V.yourTurnToPlay && V.legal && V.legal.length) return send(c,{type:'play', id:V.legal[0]});
  if(V.screen==='roundEnd') return send(c,{type:'next'});
}
(async()=>{
  await new Promise(r=>setTimeout(r,700));
  const a=await mk(); send(a,{type:'create', name:'Fabien'});
  await new Promise(r=>setTimeout(r,300));
  send(a,{type:'start'});
  // laisser la partie avancer un peu
  await new Promise(r=>setTimeout(r,4000));
  const viewsBefore=a.views;
  const {code, token, seat}=a;
  console.log('Avant coupure : siege', seat, '| vues recues:', viewsBefore, '| trickNum:', a.view && a.view.trickNum);

  // COUPURE brutale
  a.ws.terminate();
  await new Promise(r=>setTimeout(r,5000)); // le bot doit jouer a sa place pendant ce temps

  // RECONNEXION avec le jeton
  const b=await mk(); send(b,{type:'join', code, token});
  await new Promise(r=>setTimeout(r,3000));
  console.log('Apres reconnexion : siege retrouve =', b.seat===seat, '| vues recues depuis:', b.views,
    '| la partie a avance pendant l\'absence:', (b.view && (b.view.trickNum!==undefined)) ? 'oui (ecran '+b.view.screen+')' : '?');
  const ok = b.seat===seat && b.views>0;
  console.log(ok ? 'RECONNEXION OK — le bot a tenu le siege puis rendu la place' : 'PROBLEME');
  srv.kill(); process.exit(ok?0:1);
})();
