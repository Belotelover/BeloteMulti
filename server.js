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
const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.png':'image/png', '.svg':'image/svg+xml',
  '.ico':'image/x-icon', '.json':'application/json; charset=utf-8'
};
const httpServer = http.createServer((req,res)=>{
  let p = req.url.split('?')[0];

  // liste des parties en cours, pour l'ecran d'accueil. Une simple adresse web plutot
  // qu'une connexion permanente : personne n'ouvre de socket juste pour regarder la liste.
  if(p==='/api/rooms'){
    res.writeHead(200, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'});
    res.end(JSON.stringify(roomsSummary()));
    return;
  }

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
    pending: new Set(), // connexions ayant rejoint mais n'ayant pas encore choisi de siege
    watchers: new Set(), // connexions qui REGARDENT la partie sans y jouer
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

// Les pseudos sont affiches chez TOUS les joueurs : on retire les caracteres qui
// permettraient d'injecter du HTML ou du script dans l'ecran des autres, et on limite
// la longueur. Seul point d'entree des noms -> a utiliser partout.
function cleanName(raw){
  return String(raw==null ? '' : raw)
    .replace(/[<>&"'`\\]/g, '')   // neutralise toute tentative d'injection HTML
    .replace(/\s+/g, ' ')          // pas de sauts de ligne ni d'espaces multiples
    .trim()
    .slice(0, 14) || 'Joueur';
}

function broadcast(room){
  const E=room.E;
  if(!E.S) return;
  for(let i=0;i<4;i++){
    const seat=room.seats[i];
    if(seat && seat.ws){
      send(seat.ws, { type:'view', view: E.viewFor(i), players: playersInfo(room) });
    }
  }
  if(room.watchers.size){
    // viewFor(-1) ne correspond a aucun siege : main vide, aucun tour, aucun coup legal.
    // Le spectateur voit donc exactement ce qui est public, jamais une carte cachee.
    const vue = E.viewFor(-1);
    for(const w of room.watchers) send(w, { type:'view', view: vue, players: playersInfo(room), watching:true });
  }
  armInactivityTimer(room);
}

// Quel siege HUMAIN doit agir maintenant (enchere ou jeu) ? -1 si c'est un bot ou personne.
function humanSeatToAct(room){
  const E=room.E, S=E.S;
  if(!S) return -1;
  let seat=-1;
  if(S.screen==='bidding') seat=S.biddingTurn;
  else if(S.screen==='play') seat=E.currentPlayerToPlay();
  else if(S.screen==='dealChoice') seat=S.dealer;
  else return -1;
  // seat doit etre un HUMAIN reellement connecte (un siege occupe avec une socket vivante)
  const s=room.seats[seat];
  return (s && s.ws) ? seat : -1;
}

// Si un humain doit jouer mais reste inactif trop longtemps, on le fait remplacer par un bot
// pour CE coup (comme une deconnexion), afin de ne jamais bloquer la table. Timer rearme a
// chaque broadcast : tant que le joueur agit, il n'est jamais remplace.
const INACTIVITY_MS = parseInt(process.env.INACTIVITY_MS||'40000', 10);
function armInactivityTimer(room){
  if(room.inactivityTimer){ clearTimeout(room.inactivityTimer); room.inactivityTimer=null; }
  const E=room.E, S=E.S;
  if(!S) return;

  // Cas 1 : ecran de recap de fin de manche. N'importe qui peut cliquer "suivant" pour
  // toute la table ; si PERSONNE ne clique, on avance tout seul (sinon la table gele).
  // On n'exclut personne ici : ce n'est le tour de personne en particulier.
  if(S.screen==='roundEnd'){
    room.inactivityTimer = setTimeout(()=>{
      if(room.E.S && room.E.S.screen==='roundEnd') room.E.nextRoundOrEnd();
    }, INACTIVITY_MS);
    return;
  }

  // Cas 2 : c'est le tour d'un humain precis. S'il ne joue pas, un bot prend sa place.
  const seat = humanSeatToAct(room);
  if(seat<0) return;
  room.inactivityTimer = setTimeout(()=>{
    // on revalide que c'est toujours le meme humain qui bloque (rien n'a bouge entre-temps)
    if(humanSeatToAct(room)!==seat) return;
    // meme traitement qu'une deconnexion : le siege devient "BOT <prenom>" et le bot joue
    onInactivityTimeout(room, seat);
  }, INACTIVITY_MS);
}
function onInactivityTimeout(room, seat){
  const s=room.seats[seat];
  if(!s) return;
  // on coupe proprement sa socket (il pourra revenir via son pseudo -> "BOT <prenom>")
  const ws=s.ws;
  if(ws){ try{ ws._inactivityKicked=true; ws.close(); }catch(e){} }
  onDisconnect(room, seat); // libere le siege, installe "BOT <prenom>", relance le jeu
}

// Resume public des parties : ce qu'il faut pour choisir laquelle rejoindre, rien de plus
// (aucune carte, aucun etat de jeu ne transite ici).
function roomsSummary(){
  const out=[];
  for(const [code,room] of rooms){
    const joueurs=[0,1,2,3].filter(i=>room.seats[i] && room.seats[i].ws).map(i=>room.seats[i].name);
    const libres=[0,1,2,3].filter(i=>!room.seats[i]).length;
    if(!joueurs.length && !room.pending.size) continue; // partie vide : inutile de l'afficher
    out.push({ code, joueurs, libres, started: room.started, enAttente: room.pending.size });
  }
  // les tables les plus animees d'abord, puis celles qui attendent encore du monde
  out.sort((a,b)=> b.joueurs.length-a.joueurs.length || a.started-b.started);
  return out;
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
  // Le moteur (concu pour le solo) assigne par defaut une personnalite de bot fixe aux
  // sieges 1,2,3 sans savoir qu'un humain peut s'y trouver en multi. Sans correction, ses
  // textes internes (bandeau, "X remporte le pli"...) garderaient le nom du bot meme si
  // un vrai joueur y est assis. On corrige : nom du joueur pour les sieges humains,
  // personnalite de secours pour les sieges reellement tenus par un bot.
  for(let i=0;i<4;i++){
    if(room.seats[i]) E.S.bots[i] = { name: room.seats[i].name, style:'Humain', threshold:0 };
    else ensureBotPersona(E, i);
  }
  syncHumans(room);
  E.S.screen='play-init';
  E.beginRound();
  broadcast(room);
  // les joueurs encore sur l'ecran de choix (pas assis) doivent voir l'etat a jour,
  // sinon ils cliquent une chaise d'apres une photo perimee du lobby
  broadcastLobby(room);
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

// noms de secours pour un siege humain qui n'avait jamais eu de personnalite de bot
// (normal : seuls les sieges bots DES LE DEBUT en recoivent une via shuffledBotSeats())
const FALLBACK_BOT_NAMES = [
  {name:'Gilou', style:'Équilibré', threshold:21},
  {name:'Béa',   style:'Prudente',  threshold:25},
  {name:'Mimi',  style:'Agressif',  threshold:19}
];
function ensureBotPersona(E, seatIdx){
  if(!E.S || !E.S.bots) return;
  const cur = E.S.bots[seatIdx];
  // pas de personnalite du tout, OU un pseudo humain laisse orphelin par un depart :
  // dans les deux cas il faut une vraie personnalite de bot (style + seuil) pour jouer.
  // On CLONE le modele (sinon renommer le bot modifierait l'objet partage pour tous).
  if(!cur || cur.style==='Humain'){
    E.S.bots[seatIdx] = Object.assign({}, FALLBACK_BOT_NAMES[seatIdx % FALLBACK_BOT_NAMES.length]);
  }
}

function onDisconnect(room, seatIdx){
  const seat = room.seats[seatIdx];
  if(!seat) return;
  const departedName = seat.name;
  // Le siege redevient une chaise de BOT ordinaire, entierement libre : n'importe qui
  // (y compris le joueur parti, via son pseudo ou un simple clic) peut la reprendre comme
  // n'importe quelle chaise vide. Le bot prend le nom "BOT <prenom>" pour qu'on voie qui il
  // remplace. Plus de statut "deconnecte" a gerer : un seul cas, la chaise libre.
  room.seats[seatIdx] = null;
  syncHumans(room);
  const E=room.E, S=E.S;

  // Depart AVANT le lancement (lobby) : il n'y a pas encore d'etat de jeu, mais il faut
  // quand meme prevenir les autres, sinon ils continuent de voir la personne assise et
  // ne peuvent pas prendre sa place (ni savoir que la table n'est plus complete).
  if(!S || !room.started){ broadcastLobby(room); return; }

  // installe une vraie personnalite de bot (style + seuil) sur ce siege, puis on remplace
  // juste son NOM affiche par "BOT <prenom>" pour montrer qui il remplace
  E.S.bots[seatIdx] = null;         // efface l'ancienne identite humaine
  ensureBotPersona(E, seatIdx);     // reinstalle une personnalite de bot complete
  E.S.bots[seatIdx].name = 'BOT ' + departedName;
  // si le jeu attendait CE joueur, on relance la boucle pour que le bot joue a sa place.
  // (Sans cela la table gele : le moteur s'etait arrete en attendant un clic humain.)
  if(S.screen==='bidding' && S.biddingTurn===seatIdx) E.FX.later(()=>E.advanceBidding(), 400);
  if(S.screen==='play' && E.currentPlayerToPlay()===seatIdx) E.FX.later(()=>E.playTurn(), 400);
  if(S.screen==='dealChoice' && S.dealer===seatIdx){ S.dealFirst = Math.random()<0.8?3:2; E.startRound(); }
  autoAdvanceIfEmpty(room);
  broadcast(room);
}

// menage : rooms inactives > 2h
setInterval(()=>{
  const now=Date.now();
  for(const [code,room] of rooms){
    if(now-room.lastActivity > 2*3600*1000){
      if(room.inactivityTimer) clearTimeout(room.inactivityTimer);
      for(const s of room.seats) if(s && s.ws) try{ s.ws.close(); }catch(e){}
      rooms.delete(code);
    }
  }
}, 10*60*1000);

// ---------- websocket ----------
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws)=>{
  ws._room=null; ws._seat=-1; ws._name='';

  ws.on('message', (raw)=>{
    let msg; try{ msg=JSON.parse(raw); }catch(e){ return; }
    if(ws._room) ws._room.lastActivity=Date.now();

    // battement de coeur : repond a TOUT moment (meme avant de rejoindre une partie ou
    // avant d'avoir choisi un siege) — c'est ce qui permet au client de detecter une
    // connexion "zombie" (readyState toujours OPEN mais tuyau reellement mort, frequent
    // sur mobile en arriere-plan / changement wifi-4G) et de reconnecter proactivement
    if(msg.type==='ping'){ send(ws,{type:'pong'}); return; }

    // --- creation d'une partie : le createur choisit aussi sa place (table vide, trivial) ---
    if(msg.type==='create'){
      const room=createRoom();
      enterAsPending(room, msg.name);
      return;
    }

    // --- rejoindre une partie existante : on n'assigne PLUS de siege automatiquement.
    // Chaque joueur choisit sa place lui-meme via 'sit', avant d'etre reellement installe. ---
    if(msg.type==='join'){
      const room=rooms.get(String(msg.code||'').toUpperCase());
      if(!room){ send(ws,{type:'error', error:'Partie introuvable'}); return; }
      // reconnexion par jeton : on retrouve directement son ancien siege s'il existe encore
      if(msg.token){
        const idx=room.seats.findIndex(s=>s && s.token===msg.token);
        if(idx>=0){
          reclaimSeat(room, ws, idx);
          return;
        }
      }
      // reconnexion par PSEUDO : si un siege est tenu par le bot "BOT <pseudo>" (donc issu de
      // TON depart), on t'y rassoit automatiquement. Meme pseudo = meme place, y compris
      // depuis un autre appareil sans le jeton. Le bot cede la place et redevient toi.
      const wantName = cleanName(msg.name);
      if(wantName && room.E.S && room.E.S.bots){
        const idx=[0,1,2,3].findIndex(i=>!room.seats[i] && room.E.S.bots[i] && room.E.S.bots[i].name==='BOT '+wantName);
        if(idx>=0){
          reseatReturningPlayer(room, ws, idx, wantName);
          return;
        }
      }
      // mode spectateur : on regarde sans prendre de place. Si la partie n'a pas encore
      // commence, il n'y a rien a regarder : on bascule sur le choix de siege.
      if(msg.mode==='watch' && room.started){ enterAsWatcher(room, msg.name); return; }

      // sinon (nouvel arrivant, ou aucune place a ton nom) : on entre en attente et on
      // choisit une chaise libre — les sieges liberes par un depart en font partie.
      enterAsPending(room, msg.name);
      return;
    }

    if(!ws._room) return;
    const myRoom=ws._room;

    // un spectateur veut finalement prendre une chaise : il rejoint l'ecran de choix
    if(msg.type==='want-seat'){
      myRoom.watchers.delete(ws);
      enterAsPending(myRoom, ws._name);
      return;
    }

    // --- choisir sa place : fonctionne aussi bien pour le tout premier choix (pas encore
    // assis, on vient de rejoindre) que pour changer de siege plus tard dans le lobby ---
    if(msg.type==='sit'){
      const t = msg.seat|0;
      if(t<0 || t>3 || myRoom.seats[t]!==null) return; // la chaise doit etre libre
      // en cours de partie, un joueur DEJA assis ne change plus de place (verrou),
      // mais un NOUVEL arrivant peut s'installer sur une chaise tenue par un bot :
      // c'est tout l'interet de pouvoir rejoindre a n'importe quel moment
      if(myRoom.started && ws._seat>=0) return;
      seatConnection(myRoom, ws, t);
      return;
    }

    if(ws._seat<0) return; // pas encore assis : rien d'autre n'est permis

    if(msg.type==='start'){ startGame(myRoom); return; }

    const E=myRoom.E, S=E.S;
    if(!myRoom.started || !S) return;

    // --- actions de jeu : le moteur revalide tout (siege, tour, legalite) ---
    const mySeat=ws._seat;
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
      case 'say': {
        const all=[].concat(E.PHRASES.praise,E.PHRASES.regret,E.PHRASES.cheer,E.PHRASES.tease,E.PHRASES.polite);
        if(all.includes(msg.text)) E.say(mySeat, msg.text); // uniquement les phrases fermees
        break;
      }
    }
  });

  // le joueur est associe a la room mais PAS ENCORE a un siege : il doit choisir sa place
  function enterAsWatcher(room, name){
    ws._room=room; ws._seat=-1; ws._name=cleanName(name);
    room.pending.delete(ws);
    room.watchers.add(ws);
    send(ws,{type:'watch', code:room.code, players:playersInfo(room),
             view: room.E.S ? room.E.viewFor(-1) : null});
  }

  function enterAsPending(room, name){
    ws._room=room; ws._seat=-1; ws._name=cleanName(name);
    room.pending.add(ws);
    send(ws,{type:'choose-seat', code:room.code, players:playersInfo(room)});
  }

  ws.on('close', ()=>{
    if(ws._room) ws._room.watchers.delete(ws);
    if(ws._room && ws._seat>=0) onDisconnect(ws._room, ws._seat);
    else if(ws._room) ws._room.pending.delete(ws); // depart avant meme d'avoir choisi une place
  });
});

// Un joueur revient et une place porte "BOT <son pseudo>" : on la lui rend. Le siege
// redevient humain a son nom (nouveau jeton pour les prochaines reconnexions rapides).
function reseatReturningPlayer(room, ws, idx, name){
  const token = crypto.randomBytes(12).toString('hex');
  room.seats[idx] = { name, token, ws };
  ws._room = room; ws._seat = idx;
  room.pending.delete(ws);
  syncHumans(room);
  if(room.E.S) room.E.S.bots[idx] = { name, style:'Humain', threshold:0 };
  send(ws,{type:'joined', code:room.code, seat:idx, token, started:room.started});
  if(room.started) broadcast(room); else broadcastLobby(room);
}

function reclaimSeat(room, ws, idx){
  const seat = room.seats[idx];
  seat.ws = ws;
  ws._room = room; ws._seat = idx;
  syncHumans(room);
  if(room.E.S) room.E.S.bots[idx] = { name: seat.name, style:'Humain', threshold:0 };
  send(ws,{type:'joined', code:room.code, seat:idx, token:seat.token, started:room.started});
  if(room.started) broadcast(room); else broadcastLobby(room);
}

function seatConnection(room, ws, t){
  if(room.seats[t]!==null) return false;
  room.watchers.delete(ws); // il prend une chaise : ce n'est plus un spectateur
  if(ws._seat<0){
    room.pending.delete(ws);
    const token=crypto.randomBytes(12).toString('hex');
    room.seats[t] = { name: cleanName(ws._name), token, ws };
  }else{
    room.seats[t]=room.seats[ws._seat];
    room.seats[ws._seat]=null;
  }
  ws._seat=t;
  syncHumans(room);
  // meme correction que dans startGame() : si ce siege prend vie en cours de partie
  // (remplace un bot), le moteur doit connaitre son vrai nom pour ses textes internes
  if(room.E.S) room.E.S.bots[t] = { name: room.seats[t].name, style:'Humain', threshold:0 };
  send(ws,{type:'joined', code:room.code, seat:t, token:room.seats[t].token, started:room.started});
  if(room.started){
    broadcast(room); // partie en cours : il recoit immediatement sa vue du jeu et joue
  }else{
    broadcastLobby(room);
  }
  return true;
}

function broadcastLobby(room){
  for(const s of room.seats) if(s && s.ws) send(s.ws,{type:'lobby', players:playersInfo(room), started:room.started});
  for(const w of room.pending) send(w,{type:'choose-seat', code:room.code, players:playersInfo(room)});
}

httpServer.listen(PORT, ()=>console.log('Belote server sur le port', PORT));
