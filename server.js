// ============================================================================
// Serveur Belote multijoueur.
//
// Principes :
//  - Le serveur est le SEUL detenteur de la verite : il fait tourner le meme
//    moteur que la version solo (belote-engine.js) et valide chaque action.
//  - Chaque joueur ne recoit JAMAIS que sa vue filtree (viewFor), donc il est
//    structurellement impossible de voir les cartes des autres.
//  - Les sieges vides sont tenus par les bots ; un joueur deconnecte est
//    remplace par un bot le temps de revenir (jeton de reconnexion).
//
// Une "room" = une partie. Code a 4 lettres a partager entre amis.
// ============================================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 10000; // Render fournit PORT

// ---------- petit serveur statique (la page du jeu) ----------
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.svg':'image/svg+xml' };
const httpServer = http.createServer((req,res)=>{
  let p = req.url.split('?')[0];
  if(p==='/' ) p='/index.html';
  const file = path.join(PUBLIC, path.normalize(p).replace(/^([.][.][\/\\])+/,''));
  if(!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err,data)=>{
    if(err){ res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {'Content-Type': MIME[path.extname(file)] || 'application/octet-stream'});
    res.end(data);
  });
});

// ---------- rooms ----------
// Chaque room charge sa PROPRE instance du moteur (etat independant) en
// invalidant le cache de require : simple et suffisant a notre echelle.
function freshEngine(){
  const p = require.resolve('./belote-engine.js');
  delete require.cache[p];
  return require('./belote-engine.js');
}

const rooms = new Map(); // code -> room

function makeCode(){
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sans I ni O (confusion 1/0)
  let c;
  do { c = Array.from({length:4}, ()=>letters[crypto.randomInt(letters.length)]).join(''); }
  while(rooms.has(c));
  return c;
}

function createRoom(){
  const E = freshEngine();
  const room = {
    code: makeCode(),
    E,
    started: false,
    // par siege : { name, token, ws|null }  — null = siege bot
    seats: [null, null, null, null],
    lastActivity: Date.now()
  };
  // cablage FX -> reseau
  E.FX.render = ()=>broadcast(room);
  const SPEED = process.env.FAST ? 12 : 1; // FAST=1 : tests accélérés uniquement
  E.FX.later  = (fn, ms)=>{
    const g = E.S ? E.S.gen : 0;
    setTimeout(()=>{ if(rooms.has(room.code) && E.S && E.S.gen===g) fn(); }, Math.max(20, ms/SPEED));
  };
  E.FX.trickChatter = (winner)=>{ /* les bots parlent via say() qui passe par FX.render/later */
    try{
      // reutilise la logique solo : bavardage occasionnel des sieges bots
      const S=E.S; if(!S||!S.bots) return;
      if(Math.random()>0.2) return;
      const botSeats=[0,1,2,3].filter(i=>!room.seats[i] && i!==winner && S.bots[i]);
      if(!botSeats.length) return;
      const p=botSeats[Math.floor(Math.random()*botSeats.length)];
      const style=S.bots[p].style;
      const won = E.TEAM_OF[p]===E.TEAM_OF[winner];
      const PH=E.PHRASES;
      const bag = won ? (style==='Agressif'?PH.cheer.concat(PH.praise):PH.praise)
                      : (style==='Agressif'?PH.tease.concat(PH.regret)
                        : style==='Prudente'?PH.regret:PH.regret.concat(PH.cheer));
      E.say(p, E.pick(bag));
    }catch(e){}
  };
  rooms.set(room.code, room);
  return room;
}

function humanSeats(room){
  return new Set([0,1,2,3].filter(i=>room.seats[i] && room.seats[i].ws));
}

function syncHumans(room){
  if(room.E.S) room.E.S.humans = humanSeats(room);
}

function send(ws, msg){ try{ ws.send(JSON.stringify(msg)); }catch(e){} }

function broadcast(room){
  const E=room.E;
  if(!E.S) return;
  for(let i=0;i<4;i++){
    const seat=room.seats[i];
    if(seat && seat.ws){
      send(seat.ws, { type:'view', view: E.viewFor(i), players: playersInfo(room) });
    }
  }
}

function playersInfo(room){
  return [0,1,2,3].map(i=>{
    const s=room.seats[i];
    if(s) return { seat:i, name:s.name, human:true, connected: !!s.ws };
    const bots = room.E.S && room.E.S.bots;
    return { seat:i, name: bots && bots[i] ? bots[i].name : 'Bot', human:false, connected:true };
  });
}

function startGame(room){
  if(room.started) return;
  room.started = true;
  const E=room.E;
  E.newGame();
  // noms des bots pour les sieges non tenus (le moteur en a deja pour 1,2,3 ;
  // si le siege 0 est un bot on lui donne un nom aussi)
  if(!room.seats[0]) E.S.bots[0] = { name:'Lucien', style:'Équilibré', threshold:21 };
  syncHumans(room);
  E.S.screen='play-init';
  E.beginRound();
  broadcast(room);
}

// deconnexion : le bot reprend le siege ; si l'action attendue etait a ce
// joueur, on relance la machine pour que le bot joue.
// si plus aucun humain n'est connecte, le serveur enchaine tout seul les ecrans
// qui attendent normalement un clic (recap de manche) pour ne pas figer la table
function autoAdvanceIfEmpty(room){
  const E=room.E, S=E.S;
  if(!S) return;
  if(humanSeats(room).size>0) return;
  if(S.screen==='roundEnd'){
    E.FX.later(()=>{ if(humanSeats(room).size===0) { E.nextRoundOrEnd(); autoAdvanceIfEmpty(room); } }, 3000);
  }
}

function onDisconnect(room, seatIdx){
  const seat = room.seats[seatIdx];
  if(!seat) return;
  seat.ws = null;
  syncHumans(room);
  const E=room.E, S=E.S;
  if(!S) return;
  // si le jeu attendait CE joueur, on repart
  if(S.screen==='bidding' && S.biddingTurn===seatIdx) E.FX.later(()=>{ requireFn(E,'advanceBidding')(); }, 400);
  if(S.screen==='play' && E.currentPlayerToPlay()===seatIdx) E.FX.later(()=>{ requireFn(E,'playTurn')(); }, 400);
  if(S.screen==='dealChoice' && S.dealer===seatIdx){ S.dealFirst = Math.random()<0.8?3:2; E.startRound(); }
  autoAdvanceIfEmpty(room);
  broadcast(room);
}

// certaines fonctions internes ne sont pas exportees : on les atteint via un
// petit detour controle (elles existent dans la portee du module)
function requireFn(E, name){
  // advanceBidding / playTurn sont pilotes par les timers du moteur ; le plus
  // simple et robuste est de re-declencher via l'API publique quand possible.
  if(name==='advanceBidding') return ()=>{ const S=E.S; if(S.screen==='bidding' && !E.isHumanSeat(S.biddingTurn)) { /* le prochain FX.later du moteur suivra */ E.humanPass; } };
  return ()=>{};
}

// menage : rooms inactives > 2h
setInterval(()=>{
  const now=Date.now();
  for(const [code,room] of rooms){
    if(now-room.lastActivity > 2*3600*1000){
      for(const s of room.seats) if(s && s.ws) try{ s.ws.close(); }catch(e){}
      rooms.delete(code);
    }
  }
}, 10*60*1000);

// ---------- websocket ----------
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws)=>{
  let myRoom=null, mySeat=-1;

  ws.on('message', (raw)=>{
    let msg; try{ msg=JSON.parse(raw); }catch(e){ return; }
    if(myRoom) myRoom.lastActivity=Date.now();

    // --- creation / entree dans une room ---
    if(msg.type==='create'){
      const room=createRoom();
      joinRoom(room, msg.name);
      return;
    }
    if(msg.type==='join'){
      const room=rooms.get(String(msg.code||'').toUpperCase());
      if(!room){ send(ws,{type:'error', error:'Partie introuvable'}); return; }
      // reconnexion par jeton ?
      if(msg.token){
        const idx=room.seats.findIndex(s=>s && s.token===msg.token);
        if(idx>=0){
          room.seats[idx].ws=ws; myRoom=room; mySeat=idx;
          syncHumans(room);
          send(ws,{type:'joined', code:room.code, seat:idx, token:msg.token, started:room.started});
          broadcast(room);
          return;
        }
      }
      joinRoom(room, msg.name);
      return;
    }

    if(!myRoom || mySeat<0) return;
    const E=myRoom.E, S=E.S;

    if(msg.type==='sit'){
      // choisir sa chaise, uniquement dans le lobby (avant le lancement)
      const t = msg.seat|0;
      if(!myRoom.started && t>=0 && t<4 && myRoom.seats[t]===null){
        myRoom.seats[t]=myRoom.seats[mySeat];
        myRoom.seats[mySeat]=null;
        mySeat=t;
        syncHumans(myRoom);
        send(ws,{type:'joined', code:myRoom.code, seat:mySeat, token:myRoom.seats[t].token, started:false});
        for(const sx of myRoom.seats) if(sx && sx.ws) send(sx.ws,{type:'lobby', players:playersInfo(myRoom), started:false});
      }
      return;
    }
    if(msg.type==='start'){ startGame(myRoom); return; }

    if(!myRoom.started || !S) return;

    // --- actions de jeu : le moteur revalide tout (siege, tour, legalite) ---
    switch(msg.type){
      case 'deal':   E.humanChooseDeal(msg.first===2?2:3, mySeat); break;
      case 'take':   E.humanTakeRound1(mySeat); break;
      case 'suit':   E.humanPickSuit(msg.suit, mySeat); break;
      case 'pass':   E.humanPass(mySeat); break;
      case 'play': {
        const card=(S.hands[mySeat]||[]).find(c=>c.id===msg.id);
        if(card) E.humanPlay(card, mySeat);
        break;
      }
      case 'next':   E.nextRoundOrEnd(); break;
      case 'ping':   break;
      case 'say': {
        const all=[].concat(E.PHRASES.praise,E.PHRASES.regret,E.PHRASES.cheer,E.PHRASES.tease,E.PHRASES.polite);
        if(all.includes(msg.text)) E.say(mySeat, msg.text); // uniquement les phrases fermees
        break;
      }
    }
  });

  function joinRoom(room, name){
    const idx=room.seats.findIndex(s=>s===null);
    if(idx<0){ send(ws,{type:'error', error:'Partie complète (4 joueurs)'}); return; }
    const token=crypto.randomBytes(12).toString('hex');
    room.seats[idx]={ name:String(name||'Joueur').slice(0,14), token, ws };
    myRoom=room; mySeat=idx;
    syncHumans(room);
    send(ws,{type:'joined', code:room.code, seat:idx, token, started:room.started});
    // informer tout le monde du lobby
    for(const s of room.seats) if(s && s.ws) send(s.ws,{type:'lobby', players:playersInfo(room), started:room.started});
    if(room.started) broadcast(room);
  }

  ws.on('close', ()=>{
    if(myRoom && mySeat>=0) onDisconnect(myRoom, mySeat);
  });
});

httpServer.listen(PORT, ()=>console.log('Belote server sur le port', PORT));
