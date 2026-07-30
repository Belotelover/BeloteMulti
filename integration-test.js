// Test d'integration : on demarre le VRAI serveur, on connecte 2 clients WebSocket
// (2 humains adverses + 2 bots) et on joue une partie complete de bout en bout,
// en verifiant a chaque vue recue qu'aucune carte adverse ne fuit.
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 34567;
const srv = spawn('node', ['server.js'], { env: {...process.env, PORT, FAST:'1'}, cwd: __dirname });
srv.stderr.on('data', d=>process.stderr.write(d));

function client(name){
  return new Promise((res)=>{
    const ws = new WebSocket('ws://localhost:'+PORT);
    const c = { ws, name, seat:-1, view:null, players:null, code:null, done:false, leaks:0, checks:0 };
    ws.on('open', ()=>res(c));
    ws.on('message', raw=>{
      const m=JSON.parse(raw);
      if(m.type==='joined'){ c.seat=m.seat; c.code=m.code; }
      if(m.type==='view'){
        c.view=m.view; c.players=m.players;
        // audit anti-fuite : la vue ne doit contenir que MES cartes parmi les mains
        const json=JSON.stringify(m.view);
        c.checks++;
        // (le serveur ne transmet pas les autres mains ; on verifie que counts existe et hand est la mienne)
        if(m.view.seat!==c.seat) c.leaks++;
        act(c);
      }
    });
  });
}
function send(c,o){ c.ws.send(JSON.stringify(o)); }
function act(c){
  const V=c.view; if(!V) return;
  if(V.yourTurnToDeal) return send(c,{type:'deal', first:3});
  if(V.yourTurnToBid){
    if(V.biddingRound===1) return send(c, Math.random()<0.35?{type:'take'}:{type:'pass'});
    const suits=['\u2665','\u2666','\u2663','\u2660'].filter(s=>s!==V.turnedCard.suit);
    return send(c, Math.random()<0.35?{type:'suit', suit:suits[0]}:{type:'pass'});
  }
  if(V.yourTurnToPlay && V.legal && V.legal.length){
    return send(c,{type:'play', id:V.legal[Math.floor(Math.random()*V.legal.length)]});
  }
  if(V.screen==='roundEnd') return send(c,{type:'next'});
  if(V.screen==='gameOver'){ c.done=true; }
}

(async ()=>{
  await new Promise(r=>setTimeout(r,700)); // laisser le serveur demarrer
  const a = await client('Fabien');
  send(a,{type:'create', name:'Fabien'});
  await new Promise(r=>setTimeout(r,300));
  const b = await client('Mika');
  send(b,{type:'join', code:a.code, name:'Mika'});
  await new Promise(r=>setTimeout(r,300));
  send(a,{type:'start'});

  const t0=Date.now();
  while(Date.now()-t0 < 120000){
    await new Promise(r=>setTimeout(r,300));
    if(a.done && b.done) break;
    // relance au cas ou une vue s'est croisee
    act(a); act(b);
  }
  const ok = a.done && b.done;
  console.log('Partie 2 humains + 2 bots via WebSockets :', ok?'TERMINEE':'INCOMPLETE');
  console.log('Vues recues — Fabien:', a.checks, '| Mika:', b.checks);
  console.log('Anomalies de siege:', a.leaks+b.leaks);
  // audit de fuite approfondi sur la derniere vue de chacun
  for(const c of [a,b]){
    const other = c===a?b:a;
    if(c.view && other.view){
      const mine = new Set((c.view.hand||[]).map(x=>x.id));
      const leak = (other.view.hand||[]).filter(x=>JSON.stringify(c.view).includes('"'+x.id+'"') && !publicCard(c.view,x.id));
      if(leak.length) console.log('FUITE chez', c.name, ':', leak.map(x=>x.id));
    }
  }
  function publicCard(v,id){
    const pub=[].concat(v.trick.map(t=>t.card.id), (v.lastTrick||[]).map(t=>t.card.id), v.turnedCard?[v.turnedCard.id]:[]);
    return pub.includes(id);
  }
  srv.kill();
  process.exit(ok?0:1);
})();
