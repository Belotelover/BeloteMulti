
// =====================================================================
// COUCHE D'EFFETS (FX) — la frontiere entre le MOTEUR (regles + bots) et
// l'exterieur. Le moteur ne touche jamais le DOM ni les timers directement :
// il passe par FX. En solo, FX est branche sur l'affichage du navigateur ;
// sur un serveur, FX est branche sur la diffusion reseau. C'est ce qui permet
// au meme moteur de tourner dans les deux mondes sans modification.
// =====================================================================
const FX = {
  render: function(){},          // "l'etat a change, montre-le"
  later:  function(fn,ms){ setTimeout(fn,ms); }, // "planifie la suite" (remplace par la version a garde de generation)
  trickChatter: function(winner){} // evenement social apres un pli (bavardage des bots en solo)
};

const SUITS = ['♥','♦','♣','♠'];
const SUIT_NAMES = {'♥':'Cœur','♦':'Carreau','♣':'Trèfle','♠':'Pique'};
const RANKS = ['7','8','9','10','V','D','R','A'];
const TRUMP_ORDER = ['7','8','D','R','10','A','9','V'];
const PLAIN_ORDER = ['7','8','9','V','D','R','10','A'];
const TRUMP_PTS = {'7':0,'8':0,'9':14,'10':10,'V':20,'D':3,'R':4,'A':11};
const PLAIN_PTS = {'7':0,'8':0,'9':0,'10':10,'V':2,'D':3,'R':4,'A':11};

// player 0 = human (bottom), 1 = right, 2 = top (partner), 3 = left
// teams: NOUS = [0,2], EUX = [1,3]
const TEAM_OF = [0,1,0,1]; // 0 = Nous, 1 = Eux
const BOT_DELAY = 400; // rythme général des bots (rapide)
const COLLECT_DELAY = 1400; // pause au moment de ramasser un pli (laissée plus longue, pour bien lire le pli)

// Tous les enchaînements du jeu passent par ce helper : chaque timer est lié au numéro de
// distribution (S.gen) au moment où il est posé. Si une nouvelle donne démarre entre-temps,
// le timer devient inerte — c'est ce qui empêche deux "chaînes" de jeu de tourner en parallèle
// (source des bugs de plis comptés en double / bots qui jouaient deux fois).

// la distribution et le jeu tournent dans le sens des aiguilles d'une montre
// (positions à l'écran : 0=bas, 1=droite, 2=haut, 3=gauche -> ordre horaire 0,3,2,1)
function nextP(p){ return (p+3)%4; }
function playerAfter(p, steps){ let r=p; for(let i=0;i<steps;i++) r=nextP(r); return r; }

let S = null; // game state

function freshDeck(){
  let d = [];
  for(const s of SUITS) for(const r of RANKS) d.push({suit:s, rank:r, id:s+r});
  for(let i=d.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [d[i],d[j]]=[d[j],d[i]]; }
  return d;
}

// À la vraie Belote, on ne rebat jamais le jeu entre deux manches : les plis sont ramassés
// dans l'ordre où ils sont tombés, puis le jeu est simplement COUPÉ (une seule coupe) avant
// d'être redistribué. C'est un vrai élément de stratégie (mémoriser l'ordre, la retourne...),
// donc on ne simule pas un mélange complet ici — seulement une coupe.
function cutDeck(order){
  const cut = 1 + Math.floor(Math.random()*(order.length-1)); // coupe entre 1 et 31
  return order.slice(cut).concat(order.slice(0,cut));
}

function newGame(){
  S = {
    screen:'home',
    scores:[0,0], // Nous, Eux
    dealer:3,
    hands:[[],[],[],[]],
    trumpSuit:null,
    taker:null,
    turnedCard:null,
    talon:[],
    biddingRound:1,
    biddingTurn:0,
    passesInRound:0,
    trick:[],
    lastTrick:null,
    showLastTrick:false,
    trickNum:0,
    leader:0,
    roundPts:[0,0],
    lastTrickWinner:null,
    banner:'',
    firstBidderSuit:null,
    humans: new Set([0]), // sieges tenus par des humains (solo : toi ; multi : un par joueur connecte)
    bots: shuffledBotSeats(), // les 3 bots changent de place à chaque nouvelle partie
    bubbles: {0:null,1:null,2:null,3:null},
    showChat: false,
    lastRoundOrder: null, // ordre du jeu ramassé à la fin de la manche précédente (null = tout premier coup, on mélange vraiment)
    pendingLitige: 0, // points "pendus" par un litige (81 partout), remis en jeu à la donne suivante
    attackPile: [], defendPile: [],
    dealFirst: 3 // le donneur choisit de donner 2 ou 3 cartes en premier (défaut 3)
  };
  FX.render();
}

function cardPts(c){ return c.suit===S.trumpSuit ? TRUMP_PTS[c.rank] : PLAIN_PTS[c.rank]; }
function cardStrength(c, leadSuit){
  if(c.suit===S.trumpSuit) return 100 + TRUMP_ORDER.indexOf(c.rank);
  if(c.suit===leadSuit) return PLAIN_ORDER.indexOf(c.rank);
  return -1;
}

// Avant chaque distribution, le donneur choisit s'il donne 2 ou 3 cartes en premier.
// Pour toi : un simple clic quand c'est ton tour de donner. Pour les bots : une habitude
// (3 en premier la plupart du temps, comme la plupart des vrais donneurs), avec une variation
// occasionnelle pour ne pas être mécanique.
function botDealChoice(){
  return Math.random()<0.8 ? 3 : 2;
}
function isHumanSeat(p){ return S.humans ? S.humans.has(p) : p===0; }

function beginRound(){
  if(isHumanSeat(S.dealer)){
    S.screen='dealChoice';
    FX.render();
  }else{
    S.dealFirst = botDealChoice();
    startRound();
  }
}
function humanChooseDeal(n, seat){
  seat = seat===undefined ? 0 : seat;
  if(S.screen!=='dealChoice' || S.dealer!==seat) return;
  S.dealFirst = n;
  startRound();
}

function startRound(){
  S.gen = (S.gen||0)+1; // numéro de distribution : tout timer d'une donne précédente devient inerte
  // purge immediate de tout ce qui reference les cartes de la donne precedente :
  // ces cartes sont redistribuees a l'instant, les laisser visibles serait une fuite d'information
  S.lastTrick=null; S.lastTrickWinner=null; S.showLastTrick=false;
  S.playedCards=[]; S.trick=[];
  const deck = S.lastRoundOrder ? cutDeck(S.lastRoundOrder) : freshDeck();
  S.hands=[[],[],[],[]];
  let order=[]; for(let i=0;i<4;i++) order.push(playerAfter(S.dealer,i+1));
  // distribution en paquets, dans l'ordre choisi par le donneur (2 ou 3 en premier), sens horaire
  const first = S.dealFirst===2 ? 2 : 3, second = 5-first;
  for(const p of order){ for(let k=0;k<first;k++) S.hands[p].push(deck.shift()); }
  for(const p of order){ for(let k=0;k<second;k++) S.hands[p].push(deck.shift()); }
  S.turnedCard = deck.shift();
  S.talon = deck; // remaining 11
  S.trumpSuit=null; S.taker=null;
  S.biddingRound=1; S.passesInRound=0;
  // Les annonces sont de l'information publique : qui a passé sur la retourne en dit long
  // sur sa faiblesse dans cette couleur, et celui qui prend annonce forcément de la force.
  S.passedTurnedSuit = new Set();
  S.bidDecisions = {0:null, 1:null, 2:null, 3:null}; // '1' / '2' / 'prend' — affiché à côté de chaque joueur
  S.biddingTurn = nextP(S.dealer);
  S.screen='bidding';
  S.banner='';
  FX.render();
  FX.later(advanceBidding, 500+BOT_DELAY);
}

function advanceBidding(){
  if(S.screen!=='bidding') return;
  if(isHumanSeat(S.biddingTurn)){ FX.render(); return; } // on attend la decision du joueur humain
  // bot decision
  const p = S.biddingTurn;
  if(isHumanSeat(p)){ FX.render(); return; }
  const suit = S.biddingRound===1 ? S.turnedCard.suit : botBestSuit(p);
  const take = suit ? botWantsTrump(p, suit) : false;
  if(take){
    resolveBid(p, suit);
  }else{
    S.banner = `${S.bots[p].name} dit ${S.biddingRound===1?'1':'2'}`;
    recordPass(p);
    S.passesInRound++;
    nextBidder();
  }
}

// Chaque bot a DESORMAIS une personnalite fixe, liee a son nom : on retrouve le meme
// caractere de partie en partie. Les seuils de prise (19/21/25) sont inchanges, seul
// le rattachement nom <-> style devient stable.
const BOT_PERSONAS = [
  {name:'Gilou',   style:'Agressif',   threshold:19},
  {name:'Béa',     style:'Agressif',   threshold:19},
  {name:'Valoche', style:'Prudente',   threshold:25},
  {name:'Mimi',    style:'Prudente',   threshold:25},
  {name:'Noël',    style:'Équilibré',  threshold:21},
  {name:'Gisèle',  style:'Équilibré',  threshold:21}
];
function shuffledBotSeats(){
  // on tire 3 bots differents parmi les 6 ; chacun apporte SA personnalite
  const pool = BOT_PERSONAS.slice();
  for(let i=pool.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [pool[i],pool[j]]=[pool[j],pool[i]]; }
  return {1:pool[0], 2:pool[1], 3:pool[2]};
}

// évaluation réaliste d'une main pour une couleur d'atout donnée :
// valeur des cartes à l'atout, bonus pour la longueur, bonus Valet+9 (belote potentielle),
// et petit bonus pour les As dans les autres couleurs
function evaluateSuit(hand, suit){
  let val=0, count=0, hasJ=false, has9=false;
  for(const c of hand){
    if(c.suit===suit){
      val += TRUMP_PTS[c.rank]; count++;
      if(c.rank==='V') hasJ=true;
      if(c.rank==='9') has9=true;
    }
  }
  if(count>=3) val += (count-2)*4;
  if(hasJ && has9) val += 6;
  for(const c of hand) if(c.suit!==suit && c.rank==='A') val+=4;
  return val;
}

function botBestSuit(p){
  const excluded = S.turnedCard ? S.turnedCard.suit : null; // au 2e tour, la couleur refusée est interdite
  let best=null,bestVal=-1;
  for(const s of SUITS){
    if(s===excluded) continue;
    const val = evaluateSuit(S.hands[p], s);
    if(val>bestVal){bestVal=val; best=s;}
  }
  return best;
}

function botWantsTrump(p, suit){
  const val = evaluateSuit(S.hands[p], suit);
  const info = S.bots[p];
  const team = TEAM_OF[p];
  const scoreGap = S.scores[team] - S.scores[1-team]; // négatif si en retard
  // en retard au score -> un peu plus de risque ; en tête -> un peu plus prudent (effet modéré, pas excessif)
  const situational = scoreGap>=0 ? Math.min(scoreGap/70, 4) : Math.max(scoreGap/60, -4);
  const roundPenalty = S.biddingRound===2 ? 3 : 0; // un peu plus exigeant au 2e tour (moins d'infos)
  const adjThreshold = Math.max(14, info.threshold + situational + roundPenalty);
  return val >= adjThreshold;
}

function nextBidder(){
  if(S.passesInRound>=4){
    if(S.biddingRound===1){
      S.biddingRound=2; S.passesInRound=0; S.biddingTurn=nextP(S.dealer);
      S.banner='Personne ne prend, second tour !';
      FX.render();
      FX.later(advanceBidding, 700+BOT_DELAY);
    }else{
      S.dealer=nextP(S.dealer);
      S.banner='Tout le monde passe, on redistribue.';
      FX.render();
      FX.later(beginRound, 900+BOT_DELAY);
    }
    return;
  }
  S.biddingTurn=nextP(S.biddingTurn);
  FX.render();
  FX.later(advanceBidding, 600+BOT_DELAY);
}

function humanPass(seat){
  seat = seat===undefined ? 0 : seat;
  if(S.screen!=='bidding' || S.biddingTurn!==seat) return;
  S.banner = (seat===0 ? 'Vous dites ' : (S.bots && S.bots[seat] ? S.bots[seat].name+' dit ' : 'Joueur dit ')) + (S.biddingRound===1?'1':'2');
  recordPass(seat);
  S.passesInRound++;
  nextBidder();
}
function humanTakeRound1(seat){
  seat = seat===undefined ? 0 : seat;
  if(S.screen!=='bidding' || S.biddingTurn!==seat || S.biddingRound!==1) return;
  resolveBid(seat, S.turnedCard.suit);
}
function humanPickSuit(suit, seat){
  seat = seat===undefined ? 0 : seat;
  if(S.screen!=='bidding' || S.biddingTurn!==seat || S.biddingRound!==2) return;
  resolveBid(seat, suit);
}

function resolveBid(p, suit){
  if(S.screen!=='bidding') return; // garde anti-doublon
  S.taker=p; S.trumpSuit=suit;
  if(S.bidDecisions) S.bidDecisions[p]='prend';
  S.banner = (p===0?'Vous prenez':`${S.bots[p].name} prend`) + ' à ' + suitSymbolLabel(suit);
  finishDeal();
}

function suitSymbolLabel(s){ return s + ' (' + SUIT_NAMES[s] + ')'; }

function finishDeal(){
  // le preneur récupère directement la carte retournée dans sa main
  const seenTurned = S.turnedCard;
  S.hands[S.taker].push(S.turnedCard);
  let order=[]; for(let i=0;i<4;i++){ const p=playerAfter(S.dealer,i+1); if(p!==S.taker) order.push(p); }
  for(const p of order){ for(let k=0;k<3;k++) S.hands[p].push(S.talon.shift()); }
  for(let k=0;k<2;k++) S.hands[S.taker].push(S.talon.shift());
  S.talon=[];
  S.turnedCard=null;
  S.trick=[]; S.trickNum=0; S.roundPts=[0,0];
  S.lastTrick=null; S.showLastTrick=false;
  S.bubbles={0:null,1:null,2:null,3:null}; S.showChat=false; S.themeToast=null;
  S.leader=nextP(S.dealer);

  // Belote-Rebelote : le joueur qui détient Roi + Dame d'atout annoncera en les jouant
  S.beloteHolder=null;
  for(let i=0;i<4;i++){
    const h=S.hands[i];
    if(h.some(c=>c.suit===S.trumpSuit && c.rank==='R') && h.some(c=>c.suit===S.trumpSuit && c.rank==='D')){
      S.beloteHolder=i; break;
    }
  }
  S.beloteFirstPlayed=false;
  S.beloteBonusAwarded=false;
  S.beloteBonus={team:null, points:0};
  S.tricksWonByTeam=[0,0]; // pour détecter le capot (une équipe qui remporte les 8 plis)
  S.attackPile=[]; // plis remportés par l'équipe du preneur
  S.defendPile=[]; // plis remportés par l'équipe adverse

  // Suivi des "vides" révélés : si un joueur ne fournit pas la couleur demandée, on sait qu'il n'en a plus.
  // Un bon joueur s'en sert pour, en défense, jouer volontairement dans le vide de son partenaire
  // afin de lui laisser couper et engranger des points.
  S.voidKnown = {0:new Set(), 1:new Set(), 2:new Set(), 3:new Set()};
  S.playedCards = []; // toutes les cartes déjà tombées : information publique, vue par tout le monde
  // Le jeu est aussi une conversation : une défausse dit quelque chose, et tout le monde l'entend.
  S.signalStrong = {0:{}, 1:{}, 2:{}, 3:{}}; // couleur -> poids : un INDICE, jamais une certitude
  S.signalWeak   = {0:new Set(), 1:new Set(), 2:new Set(), 3:new Set()}; // "n'y reviens pas, je m'en débarrasse"
  S.takerKnownCard = seenTurned; // la retourne a été vue par tous : on sait que le preneur l'a prise en main

  // Le Valet d'atout (20 pts, carte maîtresse absolue) : tant qu'il n'est pas tombé,
  // sortir son 9 d'atout sans l'avoir soi-même est risqué (un adversaire peut le couper avec le Valet).
  S.trumpJackGone=false;

  S.screen='play';
  FX.render();
  FX.later(playTurn, 700+BOT_DELAY);
}

function legalMoves(p, leadSuit){
  const hand=S.hands[p];
  if(!leadSuit) return hand.slice();

  const info = currentWinnerInfo();
  const partnerWinning = info && TEAM_OF[info.player]===TEAM_OF[p];

  if(leadSuit===S.trumpSuit){
    // atout demandé : il faut fournir l'atout, et monter si possible sauf si le partenaire est maître
    const trumps = hand.filter(c=>c.suit===S.trumpSuit);
    if(trumps.length===0) return hand.slice();
    if(partnerWinning) return trumps;
    const beat = trumps.filter(c=>TRUMP_ORDER.indexOf(c.rank) > TRUMP_ORDER.indexOf(info.card.rank));
    return beat.length? beat : trumps;
  }

  // couleur non-atout demandée
  const followSuit = hand.filter(c=>c.suit===leadSuit);
  if(followSuit.length) return followSuit; // fournir la couleur, pas d'obligation de monter en couleur

  // pas la couleur demandée : coupe obligatoire, sauf partenaire maître
  const trumps = hand.filter(c=>c.suit===S.trumpSuit);
  if(trumps.length===0) return hand.slice(); // pas d'atout : défausse libre
  if(partnerWinning) return hand.slice(); // partenaire maître : libre de couper ou non

  if(info && info.card.suit===S.trumpSuit){
    // il faut surcouper si possible
    const beat = trumps.filter(c=>TRUMP_ORDER.indexOf(c.rank) > TRUMP_ORDER.indexOf(info.card.rank));
    return beat.length? beat : trumps;
  }
  // le maître actuel n'est pas à l'atout : n'importe quel atout coupe
  return trumps;
}

function currentWinnerInfo(){
  if(S.trick.length===0) return null;
  const leadSuit = S.trick[0].card.suit;
  let best=S.trick[0];
  for(const play of S.trick.slice(1)){
    const sBest = cardStrength(best.card, leadSuit);
    const sCur = cardStrength(play.card, leadSuit);
    if(sCur>sBest) best=play;
  }
  return best;
}

function playTurn(){
  if(S.screen!=='play' || S.trickNum>=8) return; // manche finie : on attend endRound, rien à jouer
  const p = currentPlayerToPlay();
  if(p===null) return; // pli complet : finishTrick est déjà programmé par playCard, ne pas le rappeler ici
  if(S.hands[p].length===0) return; // main vide : timer périmé, on ignore
  if(isHumanSeat(p)){ FX.render(); return; } // on attend le clic du joueur humain
  const leadSuit = S.trick.length? S.trick[0].card.suit : null;
  const moves = legalMoves(p, leadSuit);
  const card = (S.trick.length===0) ? botLeadCard(p, moves) : botChooseCard(p, moves, leadSuit);
  playCard(p, card);
}

function currentPlayerToPlay(){
  if(S.trick.length>=4) return null;
  return playerAfter(S.leader, S.trick.length);
}

// =====================================================================
// PROJECTION : viewFor(p) = ce que le joueur du siege p a le DROIT de voir.
// C'est LE point d'anti-triche du multijoueur : le serveur n'envoie jamais
// autre chose que cette vue. Elle contient sa main, l'information publique,
// et le nombre de cartes des autres — jamais leurs cartes.
// =====================================================================
function viewFor(p){
  const v = {
    seat: p,
    screen: S.screen,
    scores: S.scores.slice(),
    dealer: S.dealer,
    dealFirst: S.dealFirst,
    taker: S.taker,
    trumpSuit: S.trumpSuit,
    turnedCard: S.turnedCard,             // la retourne est publique
    biddingRound: S.biddingRound,
    biddingTurn: S.biddingTurn,
    bidDecisions: S.bidDecisions ? Object.assign({}, S.bidDecisions) : null,
    hand: (S.hands && S.hands[p]) ? S.hands[p].slice() : [],
    counts: [0,1,2,3].map(i => (S.hands && S.hands[i]) ? S.hands[i].length : 0),
    trick: S.trick ? S.trick.slice() : [],
    trickNum: S.trickNum,
    leader: S.leader,
    roundPts: S.roundPts ? S.roundPts.slice() : [0,0],
    lastTrick: S.lastTrick ? S.lastTrick.slice() : null,
    lastTrickWinner: S.lastTrickWinner,
    pendingLitige: S.pendingLitige || 0,
    beloteBonus: S.beloteBonus ? Object.assign({}, S.beloteBonus) : null, // publique une fois annoncee
    banner: S.banner,
    bots: S.bots,
    bubbles: S.bubbles ? Object.assign({}, S.bubbles) : null,
    roundResult: S.roundResult || null,
    tricksWonByTeam: S.tricksWonByTeam ? S.tricksWonByTeam.slice() : null,
    gen: S.gen,
    // aides pour le client : est-ce a moi d'agir, et quels coups sont legaux ?
    yourTurnToBid: S.screen==='bidding' && S.biddingTurn===p,
    yourTurnToDeal: S.screen==='dealChoice' && S.dealer===p,
    yourTurnToPlay: S.screen==='play' && currentPlayerToPlay()===p,
    legal: null
  };
  if(v.yourTurnToPlay){
    const leadSuit = S.trick.length ? S.trick[0].card.suit : null;
    v.legal = legalMoves(p, leadSuit).map(c=>c.id);
  }
  return v;
}


// ---------- PETITES PHRASES ----------
// Jeu de phrases volontairement FERMÉ et purement social : à la belote, communiquer une
// information de jeu à son partenaire est de la triche, donc aucune phrase ne parle des cartes.
const PHRASES = {
  praise: ['Bien joué !', 'Joli coup', 'Chapeau', 'Bien vu'],
  regret: ['Dommage', 'Presque !', 'Aïe', 'Pas de chance'],
  cheer:  ['Allez là !', 'On y va', 'Courage'],
  tease:  ['Regarde la route 😄', 'Tu dors ?', 'Ça fait mal'],
  polite: ['Salut !', 'Bonne partie', 'Merci'],
  // phrases reservees aux joueurs humains (les bots n'y piochent pas)
  humanOnly: ["Salut c'est Franck Leboeuf"]
};
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

function say(p, text){
  if(!S.bubbles) S.bubbles={0:null,1:null,2:null,3:null};
  S.bubbles[p]=text;
  FX.render();
  FX.later(()=>{ if(S.bubbles && S.bubbles[p]===text){ S.bubbles[p]=null; FX.render(); } }, 2600);
}

// Les bots réagissent selon leur tempérament (celui qu'on garde en interne) : l'agressif
// taquine et encourage, la prudente reste mesurée. Fréquence basse pour ne pas saturer.
function maybeBotChatter(winner){
  if(!S.bots || Math.random()>0.2) return;
  const speakers=[1,2,3].filter(i=>i!==winner);
  if(!speakers.length) return;
  const p = pick(speakers);
  const style = S.bots[p].style;
  const wonTogether = TEAM_OF[p]===TEAM_OF[winner];
  let bag;
  if(wonTogether) bag = style==='Agressif' ? PHRASES.cheer.concat(PHRASES.praise) : PHRASES.praise;
  else            bag = style==='Agressif' ? PHRASES.tease.concat(PHRASES.regret)
                      : style==='Prudente' ? PHRASES.regret
                      : PHRASES.regret.concat(PHRASES.cheer);
  say(p, pick(bag));
}

// Phrases proposées au joueur, adaptées au contexte : on ne lui sert pas une liste interminable.
function myPhraseChoices(){
  const myTeamWon = S.lastTrickWinner!==null && S.lastTrickWinner!==undefined
    && TEAM_OF[S.lastTrickWinner]===TEAM_OF[0];
  if(S.lastTrickWinner===null || S.lastTrickWinner===undefined) return PHRASES.polite.concat(['Allez là !']);
  return myTeamWon
    ? [pick(PHRASES.praise), 'Allez là !', 'On y va', pick(PHRASES.tease)]
    : [pick(PHRASES.regret), 'Presque !', 'Courage', pick(PHRASES.tease)];
}

// ---------- DÉDUCTION (les bots ne voient JAMAIS les mains des autres) ----------
// Un bot ne connaît que : sa propre main, les cartes déjà tombées, la retourne (vue par tous),
// le nombre de cartes restant à chaque joueur, et les "vides" révélés quand quelqu'un n'a pas fourni.
// Tout le reste est de la déduction, comme un vrai joueur à la table.

// Les cartes que le joueur p n'a jamais vues : le paquet moins sa main, moins les cartes tombées,
// moins la retourne (que tout le monde a vue).
function unseenBy(p){
  const seen = new Set(S.playedCards.map(c=>c.id));
  for(const c of S.hands[p]) seen.add(c.id);
  if(S.takerKnownCard) seen.add(S.takerKnownCard.id);
  const out=[];
  for(const s of SUITS) for(const r of RANKS){
    const id=s+r;
    if(!seen.has(id)) out.push({suit:s, rank:r, id});
  }
  return out;
}

// Le joueur "target" peut-il encore détenir cette couleur, du point de vue de l'observateur ?
function couldHoldSuit(observer, target, suit, unseen){
  if(S.hands[target].length===0) return false;            // il n'a plus de cartes (info publique)
  if(S.voidKnown[target].has(suit)) return false;          // il a déjà montré qu'il n'en avait plus
  // la retourne est connue de tous : si le preneur l'a encore, on sait qu'il détient cette carte
  if(target===S.taker && S.takerKnownCard && S.takerKnownCard.suit===suit
     && !S.playedCards.some(c=>c.id===S.takerKnownCard.id)) return true;
  return unseen.some(c=>c.suit===suit);                    // reste-t-il des cartes de cette couleur non vues ?
}

// Estimation (pas de certitude) : "target" est-il probablement vide dans cette couleur ?
// On raisonne comme un joueur qui compte les cartes : sur les cartes encore invisibles,
// combien devraient statistiquement se trouver dans sa main.
function likelyVoid(observer, target, suit, unseen){
  if(S.voidKnown[target].has(suit)) return true;
  const inSuit = unseen.filter(c=>c.suit===suit).length;
  if(inSuit===0) return true;
  const handLen = S.hands[target].length;
  let expected = inSuit * handLen / Math.max(unseen.length,1);
  // on pondère par ce que les annonces ont révélé (force du preneur, faiblesse de ceux qui ont passé)
  if(suit===S.trumpSuit) expected *= trumpPrior(target);
  // ...et par ce que ses défausses ont laissé entendre
  if(S.signalWeak && S.signalWeak[target] && S.signalWeak[target].has(suit)) expected *= 0.5;
  return expected < 0.5; // il est peu probable qu'il en ait encore une
}

// Combien d'atouts sont encore "dehors" (ni dans ma main, ni tombés) ?
function outstandingTrumps(p, unseen){
  return unseen.filter(c=>c.suit===S.trumpSuit).length;
}

// Un passe au 1er tour porte sur la couleur de la retourne : le joueur a montré qu'il n'y était
// pas assez fort pour prendre. C'est une information publique qu'un bon joueur exploite.
function recordPass(p){
  if(S.bidDecisions) S.bidDecisions[p] = S.biddingRound===1 ? '1' : '2';
  if(S.biddingRound===1 && S.passedTurnedSuit) S.passedTurnedSuit.add(p);
}

// Déduction issue des annonces : à quel point s'attendre à trouver de l'atout chez ce joueur.
// Celui qui a pris a annoncé de la force (typiquement Valet et/ou 9, ou 3-4 atouts + des As) ;
// celui qui a passé sur cette même couleur est probablement court.
function trumpPrior(target){
  if(target===S.taker) return 1.7;
  if(S.passedTurnedSuit && S.passedTurnedSuit.has(target)
     && S.takerKnownCard && S.takerKnownCard.suit===S.trumpSuit) return 0.5;
  return 1;
}

// Un adversaire peut-il encore détenir cette couleur ?
function opponentsCouldHoldSuit(p, suit, unseen){
  for(const step of [1,2,3]){
    const op = playerAfter(p, step);
    if(TEAM_OF[op]===TEAM_OF[p]) continue;
    if(couldHoldSuit(p, op, suit, unseen)) return true;
  }
  return false;
}

// Reste-t-il de l'atout chez un ADVERSAIRE ? (les atouts du partenaire ne se "font pas tomber")
function opponentsCouldHoldTrump(p, unseen){
  for(const step of [1,2,3]){
    const op = playerAfter(p, step);
    if(TEAM_OF[op]===TEAM_OF[p]) continue;
    if(couldHoldSuit(p, op, S.trumpSuit, unseen)) return true;
  }
  return false;
}

// Un adversaire qui n'a pas encore joué dans ce pli représente-t-il une menace de coupe/surcoupe ?
// Uniquement par déduction : plus aucune lecture des mains adverses.
function opponentTrumpThreat(p, leadSuit){
  const unseen = unseenBy(p);
  const info = currentWinnerInfo();
  if(!info) return false;
  const winnerIsTrump = info.card.suit===S.trumpSuit;
  const remaining = 3 - S.trick.length;
  for(let i=1;i<=remaining;i++){
    const op = playerAfter(p,i);
    if(TEAM_OF[op]===TEAM_OF[p]) continue; // le partenaire n'est pas une menace
    if(!couldHoldSuit(p, op, S.trumpSuit, unseen)) continue; // il ne peut plus avoir d'atout
    if(winnerIsTrump){
      // le pli est déjà tenu à l'atout : il faut qu'il puisse SURCOUPER, donc qu'un atout plus
      // fort soit encore invisible (si le Valet est déjà sur le tapis, plus aucune menace)
      const higherOut = unseen.some(c=>c.suit===S.trumpSuit
        && TRUMP_ORDER.indexOf(c.rank) > TRUMP_ORDER.indexOf(info.card.rank));
      if(higherOut) return true;
    }else{
      // le maître n'est pas à l'atout : n'importe quel atout coupe, s'il peut être vide de la couleur
      if(likelyVoid(p, op, leadSuit, unseen)) return true;
    }
  }
  return false;
}

// Défausse "intelligente" : parmi les cartes défaussables, on essaie de vider une couleur
// (idéalement celle où il nous reste le moins de cartes) pour pouvoir couper dedans plus tard.
// Ce qu'une défausse raconte à la table — mais ce n'est pas toujours un appel ! Très souvent
// c'est juste un joueur qui sauve des points ou qui se débarrasse d'une carte condamnée.
// On enregistre donc un INDICE pondéré, à interpréter, pas une consigne.
function recordSignals(p, card, leadSuit){
  if(!leadSuit || card.suit===leadSuit) return;      // entame ou fourniture : aucun signal
  if(card.suit===S.trumpSuit) return;                // couper n'est pas un signal
  if(!S.signalStrong || !S.signalWeak) return;
  const info = currentWinnerInfo();                  // état du pli avant ma carte
  const teamHolds = info && TEAM_OF[info.player]===TEAM_OF[p];
  if(teamHolds && cardPts(card)>=10){
    const aceAlreadyGone = S.playedCards.some(u=>u.suit===card.suit && u.rank==='A');
    let w = 0;
    if(card.rank==='10' && !aceAlreadyGone) w = 2;   // il lâche le 10 : il garde vraisemblablement l'As
    else if(card.rank==='A') w = 1;                  // peut n'être qu'un sauvetage de points
    else w = 0.5;
    if(w) S.signalStrong[p][card.suit] = (S.signalStrong[p][card.suit]||0) + w;
  }else if(cardPts(card)===0){
    S.signalWeak[p].add(card.suit);
  }
}
function strongHint(target, suit){
  const m = S.signalStrong && S.signalStrong[target];
  return (m && m[suit]) || 0;
}

// Ma carte peut-elle encore être battue par un adversaire qui n'a pas joué ?
// On raisonne uniquement sur les cartes invisibles, et on tient compte du fait qu'un adversaire
// qui possède encore la couleur demandée sera OBLIGÉ de fournir (il ne pourra donc pas couper).
function cardCouldBeBeaten(p, myCard, leadSuit, unseen){
  const after = 3 - S.trick.length; // joueurs qui joueront après moi
  const ref = leadSuit || myCard.suit;
  for(let i=1;i<=after;i++){
    const op = playerAfter(p,i);
    if(TEAM_OF[op]===TEAM_OF[p]) continue;
    const mustFollow = leadSuit && leadSuit!==S.trumpSuit && !likelyVoid(p, op, leadSuit, unseen);
    for(const u of unseen){
      if(cardStrength(u, ref) <= cardStrength(myCard, ref)) continue;
      if(!couldHoldSuit(p, op, u.suit, unseen)) continue;
      if(u.suit===S.trumpSuit && leadSuit!==S.trumpSuit && mustFollow) continue; // il devra fournir, pas couper
      return true;
    }
  }
  return false;
}

// Nos "maîtres" établis dans les couleurs ordinaires : un As, ou un 10 devenu maître parce que
// l'As est déjà tombé. Ce sont les cartes qu'un bon joueur encaisse dès que la coupe n'est plus à craindre.
function establishedMasters(p, moves, unseen){
  const out=[];
  for(const c of moves){
    if(c.suit===S.trumpSuit) continue;
    const higherOut = unseen.some(u=>u.suit===c.suit
      && PLAIN_ORDER.indexOf(u.rank) > PLAIN_ORDER.indexOf(c.rank));
    if(!higherOut) out.push(c);
  }
  return out.sort((a,b)=>cardPts(b)-cardPts(a)); // on encaisse d'abord la plus grosse
}

// La valeur d'une carte ne se juge pas seulement sur ses points, mais sur ce qu'elle rapportera
// ENCORE. Si derrière elle je conserve dans la même couleur une carte qui prendra la main de toute
// façon, alors la première est redondante : elle ne me fera pas gagner un pli de plus, donc la
// donner au partenaire est du pur bénéfice (exemple : garder le Roi et pisser le 10).
function honourRedundancy(p, c, unseen){
  const rest = S.hands[p].filter(x=>x.suit===c.suit && x.id!==c.id);
  if(!rest.length) return false;
  const nextBest = rest.reduce((a,b)=>PLAIN_ORDER.indexOf(b.rank)>PLAIN_ORDER.indexOf(a.rank)?b:a);
  const aboveNext = unseen.filter(u=>u.suit===c.suit
    && PLAIN_ORDER.indexOf(u.rank) > PLAIN_ORDER.indexOf(nextBest.rank)).length;
  return aboveNext<=1; // après son départ, il me reste une carte quasi maîtresse dans la couleur
}

// Défausse : au lieu d'une règle rigide, on pèse toutes les raisons qui font choisir une carte.
// Le contexte change tout : si le partenaire encaisse en sécurité, donner des points est bon ;
// si c'est l'adversaire qui tient le pli, chaque point donné est une perte.
function pickDiscard(p, pool, leadSuit, partnerWinning, isDefender){
  const safeForPartner = partnerWinning && !opponentTrumpThreat(p, leadSuit);
  const unseen = unseenBy(p);
  let best=null, bestScore=-Infinity;
  for(const c of pool){
    const s = discardScore(p, c, safeForPartner, isDefender, unseen);
    if(s>bestScore){ bestScore=s; best=c; }
  }
  return best;
}

function discardScore(p, c, safeForPartner, isDefender, unseen){
  let s = 0;
  const pts = cardPts(c);
  const suitCards = S.hands[p].filter(x=>x.suit===c.suit);
  const suitCount = suitCards.length;
  const holdsAce = suitCards.some(x=>x.rank==='A');
  const holdsTen = suitCards.some(x=>x.rank==='10');

  // 1) Les points. Au partenaire : c'est du gain. À l'adversaire : c'est du don, on évite.
  s += (safeForPartner ? 3 : -3) * pts;

  // 2) Se créer une coupe : vider une couleur courte, très précieux en défense
  if(suitCount===1) s += isDefender ? 9 : 5;
  else if(suitCount===2) s += isDefender ? 4 : 2;

  // 3) Ne pas casser ses gardes : garder un 10 "sec" (sans l'As ni escorte) c'est le condamner,
  //    donc on ne jette pas la petite carte qui le protège.
  if(holdsTen && !holdsAce && c.rank!=='10' && suitCount<=2) s -= 10;
  //    de même, un As doit rester escorté pour ne pas être coupé dès qu'on entame la couleur
  if(holdsAce && c.rank!=='A' && suitCount<=2) s -= 6;

  // 4) À l'inverse : un 10 sec dont l'As est encore chez l'adversaire est condamné — il tombera
  //    de toute façon. Autant s'en défaire pendant qu'on choisit le moment.
  if(c.rank==='10' && !holdsAce && suitCount<=2){
    const aceOut = unseen.some(u=>u.suit===c.suit && u.rank==='A');
    if(aceOut && opponentsCouldHoldSuit(p, c.suit, unseen)) s += 8;
  }

  // 5) Carte redondante : si je garde derrière elle une carte qui prendra la main de toute façon
  //    dans cette couleur, la donner au partenaire ne me coûte aucun pli (garder le R, pisser le 10).
  if(safeForPartner && pts>=10 && honourRedundancy(p, c, unseen)) s += 7;

  return s;
}

// Stratégie de meneur :
// - l'équipe qui a pris a intérêt à "faire tomber les atouts" en début de manche pour épuiser
//   les atouts adverses et sécuriser ses cartes maîtresses ensuite ;
// - le défenseur qui a la main préfère sonder avec un As sûr (couleur non-atout), sinon une petite carte.
function botLeadCard(p, moves){
  const isAttacker = S.taker!==null && TEAM_OF[p]===TEAM_OF[S.taker];
  const trumps = moves.filter(c=>c.suit===S.trumpSuit);
  const trumpsLeftInHand = S.hands[p].filter(c=>c.suit===S.trumpSuit).length;
  const unseen = unseenBy(p);
  // on ne continue à faire tomber l'atout que si un ADVERSAIRE peut encore en avoir :
  // si les deux adversaires ont montré qu'ils étaient vides d'atout, insister ne sert plus à rien
  // (les atouts restants sont ceux du partenaire), il vaut mieux encaisser ses cartes maîtresses.
  const drawTrumpUseful = opponentsCouldHoldTrump(p, unseen);

  if(isAttacker && trumps.length>0 && drawTrumpUseful){
    const jack = trumps.find(c=>c.rank==='V');
    if(jack){
      // On part au Valet pour "éclaircir" : il est imbattable, il fait tomber les atouts adverses
      // et il évite de sortir ses As trop tôt pour se les faire découper au 2e ou 3e tour.
      // Vrai même avec le Valet seul en main : c'est le rôle du camp du preneur de nettoyer l'atout.
      return jack;
    }
    trumps.sort((a,b)=>TRUMP_ORDER.indexOf(b.rank)-TRUMP_ORDER.indexOf(a.rank));
    const bestMine = trumps[0];
    const strongerOut = unseen.some(c=>c.suit===S.trumpSuit
      && TRUMP_ORDER.indexOf(c.rank) > TRUMP_ORDER.indexOf(bestMine.rank));
    if(!strongerOut){
      return bestMine; // notre meilleur atout est maître : on le sort, même s'il est seul
    }
    trumps.sort((a,b)=>TRUMP_ORDER.indexOf(a.rank)-TRUMP_ORDER.indexOf(b.rank));
    const lowest = trumps[0];
    // Faire sortir l'atout est une PRIORITÉ quand notre camp a pris : ça éclaircit le jeu et
    // protège nos As. On mène donc petit atout même avec un seul en main — céder 3 ou 4 points
    // pour nettoyer l'atout est un bon investissement, même si ça paraît contre-intuitif.
    // Seules les grosses cartes (9, 10, As d'atout) ne se sacrifient pas ainsi.
    if(trumpsLeftInHand>=2 || cardPts(lowest)<=4){
      return lowest;
    }
    // atout unique et cher (9/10/As) : on le garde plutôt que de l'offrir
  }

  // "Appel" par lecture des vides : si le partenaire a montré qu'il n'avait plus une couleur,
  // on lui mène cette couleur avec notre plus grosse carte : il coupe et on ramasse un gros pli.
  if(!isAttacker){
    const partner = playerAfter(p,2);
    for(const s of SUITS){
      if(s===S.trumpSuit) continue;
      if(S.voidKnown[partner] && S.voidKnown[partner].has(s)){
        const inSuit = moves.filter(c=>c.suit===s);
        if(inSuit.length) return inSuit.sort((a,b)=>cardPts(b)-cardPts(a))[0];
      }
    }
  }

  // Encaisser ses maîtres établis (un As, ou un 10 devenu maître car l'As est tombé), à condition
  // qu'aucun adversaire ne puisse probablement couper : c'est là qu'on engrange les points.
  for(const m of establishedMasters(p, moves, unseen)){
    let risky=false;
    for(const step of [1,2,3]){
      const op = playerAfter(p, step);
      if(TEAM_OF[op]===TEAM_OF[p]) continue;
      if(couldHoldSuit(p, op, S.trumpSuit, unseen) && likelyVoid(p, op, m.suit, unseen)){ risky=true; break; }
    }
    if(!risky) return m;
  }

  // Lire les signes du partenaire : lâcher le 10 en gardant l'As dehors est un indice net
  // ("reviens, j'y suis maître"). Lâcher un As peut n'être qu'un sauvetage de points : on ne
  // bâtit pas un plan dessus, ça reste une simple préférence.
  const mate = playerAfter(p,2);
  let clearSign=null, bestW=0;
  for(const s of SUITS){
    if(s===S.trumpSuit) continue;
    const w = strongHint(mate, s);
    if(w>=2 && w>bestW && moves.some(c=>c.suit===s)){ bestW=w; clearSign=s; }
  }
  if(clearSign){
    const mine = moves.filter(c=>c.suit===clearSign);
    return mine.sort((a,b)=>cardPts(a)-cardPts(b))[0]; // on y revient petit, il prendra la main
  }

  // Dernier recours, mais raisonné : on entame petit (on ne donne pas de points), sans ouvrir
  // l'atout (surtout en défense, ce serait un cadeau au preneur), et de préférence dans notre
  // couleur la plus courte afin de s'y créer une coupe au plus vite.
  const nonTrump = moves.filter(c=>c.suit!==S.trumpSuit);
  const pool = nonTrump.length ? nonTrump : moves;
  const mateWeak = (S.signalWeak && S.signalWeak[mate]) ? S.signalWeak[mate] : new Set();
  return pool.slice().sort((a,b)=>{
    // on évite la couleur où le partenaire a dit qu'il n'avait rien
    const wa = mateWeak.has(a.suit)?1:0, wb = mateWeak.has(b.suit)?1:0;
    if(wa!==wb) return wa-wb;
    // léger penchant pour la couleur où il a laissé entendre de la force
    const ha = strongHint(mate, a.suit), hb = strongHint(mate, b.suit);
    if(ha!==hb) return hb-ha;
    const d = cardPts(a)-cardPts(b);
    if(d!==0) return d;
    const la = S.hands[p].filter(x=>x.suit===a.suit).length;
    const lb = S.hands[p].filter(x=>x.suit===b.suit).length;
    return la-lb;
  })[0];
}

// Stratégie de suiveur, avec les vrais réflexes belote :
// 1) on gagne le pli le moins cher possible si c'est utile
// 2) si le partenaire est déjà maître : on "pisse" (banque le maximum de points) uniquement si c'est
//    sans risque (aucun adversaire restant ne peut couper/surcouper) ; sinon on reste prudent
// 3) en défausse libre : le défenseur cherche à se créer une coupe (vider une couleur) plutôt que de
//    juste jeter sa carte la plus faible ; l'attaquant, lui, se contente de se délester au moins cher
// Dans tous les cas, un atout n'est jamais gaspillé s'il existe une carte non-atout jouable.
function botChooseCard(p, moves, leadSuit){
  const info = currentWinnerInfo();
  const partnerWinning = info && TEAM_OF[info.player]===TEAM_OF[p];
  const isDefender = S.taker!==null && TEAM_OF[p]!==TEAM_OF[S.taker];

  const winning = moves.filter(c=>{
    const trial = S.trick.concat([{player:p, card:c}]);
    const leadS = trial[0].card.suit;
    let best=trial[0];
    for(const pl of trial.slice(1)){ if(cardStrength(pl.card,leadS)>cardStrength(best.card,leadS)) best=pl; }
    return best.player===p;
  });
  if(winning.length && !partnerWinning){
    winning.sort((a,b)=>cardStrength(a,leadSuit||a.suit)-cardStrength(b,leadSuit||b.suit));
    const trickPts = S.trick.reduce((s,pl)=>s+cardPts(pl.card),0);
    const isLastTrick = S.trickNum===7; // 8e pli : il vaut 10 de der, on se bat pour lui
    if(trickPts>=7 || isLastTrick){
      // pli qui vaut le coup : on ne gagne pas "au plus juste" pour se faire reprendre derrière.
      // On cherche la plus petite carte qui GARANTIT le pli ; si aucune ne le garantit, inutile
      // d'y investir une grosse carte (elle serait coupée avec les points en plus) : on joue petit.
      const unseen = unseenBy(p);
      const safe = winning.find(c=>!cardCouldBeBeaten(p, c, leadSuit, unseen));
      if(safe) return safe;
      return winning[0];
    }
    return winning[0]; // pli pauvre : inutile de gaspiller une grosse carte
  }

  const forcedToFollow = leadSuit && moves.every(c=>c.suit===leadSuit);
  if(partnerWinning && forcedToFollow){
    const risky = opponentTrumpThreat(p, leadSuit);
    const sorted = moves.slice().sort((a,b)=> risky ? cardPts(a)-cardPts(b) : cardPts(b)-cardPts(a));
    return sorted[0]; // sans risque : on banque le maximum ; sinon on garde ses cartes fortes pour plus tard
  }

  // défausse libre (vide dans la couleur demandée, ou partenaire déjà maître) : ne jamais gaspiller un atout
  const nonTrump = moves.filter(c=>c.suit!==S.trumpSuit);
  const pool = nonTrump.length ? nonTrump : moves;
  return pickDiscard(p, pool, leadSuit, partnerWinning, isDefender);
}

function playCard(p, card){
  if(S.screen!=='play' || S.trick.length>=4 || currentPlayerToPlay()!==p) return; // garde anti-doublon (timers périmés, double-clics)
  const leadSuit = S.trick.length ? S.trick[0].card.suit : null;
  if(leadSuit && card.suit!==leadSuit){
    S.voidKnown[p].add(leadSuit); // n'a pas fourni : on sait qu'il n'a plus cette couleur
  }
  if(card.suit===S.trumpSuit && card.rank==='V'){
    S.trumpJackGone=true;
  }
  recordSignals(p, card, leadSuit);
  S.hands[p] = S.hands[p].filter(c=>c.id!==card.id);
  S.trick.push({player:p, card});
  S.playedCards.push(card); // information publique : tout le monde a vu cette carte tomber
  S.banner='';
  checkBelote(p, card);
  FX.render();
  if(S.trick.length>=4){
    FX.later(finishTrick, 1000+COLLECT_DELAY);
  }else{
    FX.later(playTurn, 600+BOT_DELAY);
  }
}

function checkBelote(p, card){
  if(S.beloteHolder!==p || card.suit!==S.trumpSuit) return;
  if(card.rank!=='R' && card.rank!=='D') return;
  const who = p===0 ? 'Vous annoncez' : (S.bots[p].name+' annonce');
  if(!S.beloteFirstPlayed){
    S.beloteFirstPlayed=true;
    S.banner = who+' Belote !';
  }else if(!S.beloteBonusAwarded){
    S.beloteBonusAwarded=true;
    S.beloteBonus={team:TEAM_OF[p], points:20};
    const teamName = TEAM_OF[p]===0?'Nous':'Eux';
    S.banner = who+` Rebelote ! (+20 pour ${teamName})`;
  }
}

function humanPlay(card, seat){
  seat = seat===undefined ? 0 : seat;
  if(currentPlayerToPlay()!==seat) return;
  const leadSuit = S.trick.length? S.trick[0].card.suit : null;
  const moves = legalMoves(seat, leadSuit);
  if(!moves.find(c=>c.id===card.id)){
    S.banner='Coup non autorisé !';
    FX.render();
    return;
  }
  playCard(seat, card);
}

function finishTrick(){
  if(S.screen!=='play' || S.trick.length!==4) return; // ne ramasse qu'un pli réellement complet, une seule fois
  const leadSuit = S.trick[0].card.suit;
  let best=S.trick[0];
  for(const pl of S.trick.slice(1)){ if(cardStrength(pl.card,leadSuit)>cardStrength(best.card,leadSuit)) best=pl; }
  let pts = S.trick.reduce((sum,pl)=>sum+cardPts(pl.card),0);
  S.lastTrick = S.trick.slice(); // conservé pour le bouton "Dernière main"
  S.trickNum++;
  if(S.trickNum===8) pts+=10; // dix de der
  const team = TEAM_OF[best.player];
  const cards = S.trick.map(pl=>pl.card);
  if(team===TEAM_OF[S.taker]) S.attackPile.push(...cards); else S.defendPile.push(...cards);
  S.roundPts[team]+=pts;
  S.tricksWonByTeam[team]++;
  S.lastTrickWinner=best.player;
  S.banner=(best.player===0?'Vous remportez':S.bots[best.player].name+' remporte')+' le pli (+'+pts+')';
  S.leader=best.player;
  S.trick=[];
  FX.render();
  FX.trickChatter(best.player);
  if(S.trickNum>=8){
    FX.later(endRound, 1200+BOT_DELAY);
  }else{
    FX.later(playTurn, 900+BOT_DELAY);
  }
}

function endRound(){
  if(S.screen!=='play') return; // garde : le décompte ne s'applique qu'une seule fois
  // à la table : on ramasse le tas du preneur (celui qu'on vient de compter), on le pose sur celui
  // des défenseurs, puis on coupe l'ensemble — pas de mélange
  S.lastRoundOrder = S.defendPile.concat(S.attackPile);
  const attackTeam = TEAM_OF[S.taker];
  const defendTeam = 1-attackTeam;

  // Seuil du contrat : sans belote, il faut 82 des 162 points de plis. Dès qu'une Belote-Rebelote
  // est annoncée (peu importe le camp), l'enjeu monte à 182 et le preneur doit atteindre 91.
  // S'il détient lui-même la belote, ses 20 points comptent dans son total.
  const beloteAnnounced = S.beloteBonus.team!==null;
  const need = beloteAnnounced ? 91 : 82;
  const takerTotal = S.roundPts[attackTeam] + (S.beloteBonus.team===attackTeam ? S.beloteBonus.points : 0);

  // Le litige est l'égalité parfaite sur les plis : 81 partout, sans belote en jeu.
  const litige = !beloteAnnounced && S.roundPts[attackTeam]===81 && S.roundPts[defendTeam]===81;
  let gained=[0,0];
  let made=false, litigeAdded=0;

  if(litige){
    // LITIGE : le preneur ne marque pas ses 81 points, ils sont "pendus" et remis en jeu.
    // La défense encaisse les siens immédiatement.
    gained[defendTeam]=81;
    gained[attackTeam]=0;
    S.pendingLitige = (S.pendingLitige||0) + 81;
  }else{
    made = takerTotal >= need;
    if(made){
      gained[attackTeam]=S.roundPts[attackTeam];
      gained[defendTeam]=S.roundPts[defendTeam];
    }else{
      gained[defendTeam]=162;
      gained[attackTeam]=0;
    }
    // le camp qui remporte cette donne encaisse en plus les points laissés en litige
    if(S.pendingLitige){
      const winner = made ? attackTeam : defendTeam;
      litigeAdded = S.pendingLitige;
      gained[winner]+=S.pendingLitige;
      S.pendingLitige=0;
    }
  }

  // Belote-Rebelote (Roi + Dame d'atout) : 20 points toujours acquis à l'équipe qui les détient,
  // indépendamment du contrat comme du litige
  if(S.beloteBonus.team!==null){
    gained[S.beloteBonus.team]+=S.beloteBonus.points;
  }

  // Capot : une équipe qui remporte les 8 plis touche un bonus de 90 points en plus
  const capotTeam = S.tricksWonByTeam[0]===8 ? 0 : (S.tricksWonByTeam[1]===8 ? 1 : null);
  if(capotTeam!==null){
    gained[capotTeam]+=90;
  }
  S.scores[0]+=gained[0];
  S.scores[1]+=gained[1];

  // Dernière donne de la partie : un litige ne peut plus être rejoué, chaque camp marque ses points
  let litigeSettled=0;
  if(litige && (S.scores[0]>=1000 || S.scores[1]>=1000) && S.pendingLitige){
    litigeSettled = S.pendingLitige;
    S.scores[attackTeam]+=S.pendingLitige;
    gained[attackTeam]+=S.pendingLitige;
    S.pendingLitige=0;
  }

  S.screen='roundEnd';
  S.roundResult = {attackTeam, made, gained, capotTeam, litige,
                   litigePts:81, litigeAdded, litigeSettled, need, takerTotal, beloteAnnounced};
  FX.render();
}

function nextRoundOrEnd(){
  if(S.screen!=='roundEnd') return; // garde anti double-clic
  if(S.scores[0]>=1000 || S.scores[1]>=1000){
    S.screen='gameOver';
    FX.render();
    return;
  }
  S.dealer=nextP(S.dealer);
  beginRound();
}

// ---- export : navigateur (globals) ET Node (module) ----
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    get S(){ return S; }, set S(v){ S = v; },
    FX, newGame, beginRound, startRound, nextRoundOrEnd,
    humanChooseDeal, humanPass, humanTakeRound1, humanPickSuit, humanPlay,
    viewFor, legalMoves, currentPlayerToPlay, isHumanSeat,
    // relance de la boucle de jeu : indispensable au serveur quand un humain quitte
    // pendant son tour (le bot doit prendre le relais). Ces deux fonctions s'auto-protegent
    // (elles ne font rien si ce n'est pas le bon ecran ou si le siege est humain).
    playTurn, advanceBidding,
    evaluateSuit, botBestSuit, say, myPhraseChoices, PHRASES, pick,
    SUITS, TEAM_OF, BOT_PERSONAS
  };
}
