// Deux joueurs : le 2e arrive au siege 1 (adversaire) puis CLIQUE le siege 2
// pour devenir partenaire du createur. On verifie le deplacement, le refus des
// sieges occupes, le verrouillage apres lancement, et que la partie tourne.
const { spawn } = require('child_process');
const WebSocket = require('ws');
const PORT = 34570;
const srv = spawn('node',['server.js'],{env:{...process.env,PORT,FAST:'1'},cwd:__dirname});
srv.stderr.on('data',d=>process.stderr.write('[SRV] '+d));

function mk(){ return new Promise(res=>{
  const ws=new WebSocket('ws://localhost:'+PORT);
  const c={ws,seat:-1,code:null,token:null,view:null,lobby:null};
  ws.on('open',()=>res(c));
  ws.on('message',raw=>{
    const m=JSON.parse(raw);
    if(m.type==='joined'){ c.seat=m.seat; c.code=m.code; c.token=m.token; }
    if(m.type==='lobby'){ c.lobby=m.players; }
    if(m.type==='view'){ c.view=m.view; auto(c); }
  });
});}
function send(c,o){ c.ws.send(JSON.stringify(o)); }
function auto(c){
  const V=c.view; if(!V) return;
  if(V.yourTurnToDeal) return send(c,{type:'deal',first:3});
  if(V.yourTurnToBid) return send(c,{type:'pass'});
  if(V.yourTurnToPlay && V.legal && V.legal.length) return send(c,{type:'play',id:V.legal[0]});
  if(V.screen==='roundEnd') return send(c,{type:'next'});
}
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  await wait(700);
  const a=await mk(); send(a,{type:'create',name:'Fabien'}); await wait(200);
  const b=await mk(); send(b,{type:'join',code:a.code,name:'Mika'}); await wait(200);
  console.log('1) Arrivee : Fabien siege', a.seat, '| Mika siege', b.seat);

  send(b,{type:'sit', seat:2}); await wait(200);
  console.log('2) Mika clique le siege 2 (partenaire) -> siege', b.seat, b.seat===2?'OK':'ECHEC');

  send(b,{type:'sit', seat:0}); await wait(200);
  console.log('3) Mika tente le siege de Fabien (occupe) -> siege', b.seat, b.seat===2?'OK (refuse)':'ECHEC');

  send(a,{type:'start'}); await wait(300);
  send(b,{type:'sit', seat:3}); await wait(200);
  console.log('4) Changement apres lancement -> siege', b.seat, b.seat===2?'OK (verrouille)':'ECHEC');

  // la partie doit tourner normalement (quelques plis)
  await wait(6000);
  const ok = b.view && b.view.trickNum>=1;
  console.log('5) La partie tourne avec les sieges choisis :', ok?'OK (pli '+b.view.trickNum+')':'ECHEC');
  srv.kill(); process.exit(0);
})();
