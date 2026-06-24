const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ─── CONFIG ───────────────────────────────────────────
const PORT         = process.env.PORT || 3000;
const TICK_RATE    = 60;
const W            = 900, H = 600;
const SHIP_SPEED   = 2.8;
const SHIP_TURN    = 0.045;
const BULLET_SPEED = 7;
const BULLET_LIFE  = 80;
const FIRE_CD      = 22;
const MAX_HP       = 100;
const BULLET_DMG   = 25;
const CONSEC_HEAL  = 20;
const CONSEC_REQ   = 3;
const PU_SPAWN_INT = 300;
const MAX_PU       = 4;
const PU_LIFE      = 300;
const MIN_PLAYERS  = 2;
const MAX_PLAYERS  = 8;
const RESPAWN_TICKS= 60 * 10;   // 10 seconds at 60fps

// ─── HTTP SERVER ──────────────────────────────────────
const MIME = {
  '.html':'text/html','.js':'text/javascript',
  '.css':'text/css',  '.png':'image/png','.ico':'image/x-icon',
};

const httpServer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/create-room') {
    const code = genRoomCode();
    rooms.set(code, makeRoom(code));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code }));
    return;
  }
  let filePath = path.join(__dirname, 'public',
    req.url === '/' || req.url.startsWith('/?') ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('Not found'); }
        else    { res.writeHead(200, { 'Content-Type':'text/html' }); res.end(d2); }
      });
    } else {
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
      res.end(data);
    }
  });
});

// ─── ROOMS ────────────────────────────────────────────
const rooms = new Map();

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({length:6}, ()=>chars[Math.floor(Math.random()*chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

function makeRoom(code) {
  return {
    code, ships:{}, inputs:{}, bullets:[], powerups:[],
    phase:'lobby', frame:0, puTimer:0,
    tickInterval:null, nextBulletId:0, nextPuId:0, colorIdx:0,
    clients: new Map(),
  };
}

function destroyRoom(room) {
  if (room.tickInterval) clearInterval(room.tickInterval);
  rooms.delete(room.code);
}

// ─── HELPERS ──────────────────────────────────────────
function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }
function puColor(t){ return {shield:'#44aaff',rapid:'#ffaa00',triple:'#ff44aa'}[t]||'#fff'; }

function randomEdgePos() {
  const side = Math.floor(Math.random()*4);
  if (side===0) return { x: Math.random()*W, y: 40 };
  if (side===1) return { x: Math.random()*W, y: H-40 };
  if (side===2) return { x: 40,              y: Math.random()*H };
  return              { x: W-40,             y: Math.random()*H };
}

function makeShip(room, id, name) {
  const count = Object.keys(room.ships).length;
  const angle = (count / MAX_PLAYERS) * Math.PI * 2;
  return {
    id, name,
    colorIdx: (room.colorIdx++) % 8,
    x: W/2 + Math.cos(angle)*200, y: H/2 + Math.sin(angle)*200,
    angle: angle+Math.PI, vx:0, vy:0,
    hp: MAX_HP, dead:false, spectating:false,
    respawnTimer: 0,
    kills:0, shots:0, streak:0,
    fireCd:0, inventory:[],
    activeShield:0, activeRapid:0, activeTriple:0,
  };
}

function sanitizeShips(room) {
  return Object.values(room.ships).map(s => ({
    id:s.id, name:s.name, colorIdx:s.colorIdx,
    x:s.x, y:s.y, angle:s.angle, vx:s.vx, vy:s.vy,
    hp:s.hp, dead:s.dead, spectating:s.spectating,
    respawnTimer:s.respawnTimer,
    kills:s.kills, shots:s.shots,
    inventory:s.inventory,
    activeShield:s.activeShield, activeRapid:s.activeRapid, activeTriple:s.activeTriple,
  }));
}

function broadcastRoom(room, msg) {
  const data = JSON.stringify(msg);
  for (const [ws] of room.clients) if (ws.readyState===1) ws.send(data);
}

function broadcastLobby(room) {
  broadcastRoom(room, {
    type:'lobby', code:room.code,
    players: Object.values(room.ships).map(s=>({id:s.id,name:s.name,colorIdx:s.colorIdx})),
    minPlayers: MIN_PLAYERS, phase:room.phase,
  });
}

// ─── POWERUPS ─────────────────────────────────────────
function spawnPowerup(room) {
  const types=['shield','rapid','triple'];
  room.powerups.push({
    id:room.nextPuId++,
    x:60+Math.random()*(W-120), y:60+Math.random()*(H-120),
    type:types[Math.floor(Math.random()*types.length)],
    life:PU_LIFE,
  });
}

function fireBullet(room, ship, angleOff=0) {
  const a = ship.angle+angleOff;
  room.bullets.push({
    id:room.nextBulletId++,
    x:ship.x+Math.cos(a)*18, y:ship.y+Math.sin(a)*18,
    vx:Math.cos(a)*BULLET_SPEED, vy:Math.sin(a)*BULLET_SPEED,
    life:BULLET_LIFE, ownerId:ship.id,
  });
}

// ─── TICK ─────────────────────────────────────────────
function tick(room) {
  if (room.phase !== 'playing') return;
  room.frame++;
  room.puTimer++;

  if (room.puTimer > PU_SPAWN_INT && room.powerups.length < MAX_PU) {
    spawnPowerup(room); room.puTimer=0;
  }
  room.powerups = room.powerups.filter(p => --p.life > 0);

  for (const ship of Object.values(room.ships)) {
    // ── RESPAWN COUNTDOWN ──
    if (ship.dead) {
      ship.respawnTimer--;
      if (ship.respawnTimer <= 0) {
        // Respawn at random edge facing center
        const pos = randomEdgePos();
        ship.x = pos.x; ship.y = pos.y;
        ship.angle = Math.atan2(H/2-pos.y, W/2-pos.x);
        ship.vx=0; ship.vy=0;
        ship.hp=MAX_HP; ship.dead=false; ship.spectating=false;
        ship.fireCd=60; ship.inventory=[];
        ship.activeShield=ship.activeRapid=ship.activeTriple=0;
        broadcastRoom(room, { type:'respawn', id:ship.id, name:ship.name });
      }
      continue;
    }

    const inp = room.inputs[ship.id] || {};
    if (ship.fireCd>0)       ship.fireCd--;
    if (ship.activeShield>0) ship.activeShield--;
    if (ship.activeRapid >0) ship.activeRapid--;
    if (ship.activeTriple>0) ship.activeTriple--;

    if (inp.left)    ship.angle -= SHIP_TURN;
    if (inp.right)   ship.angle += SHIP_TURN;
    if (inp.forward) { ship.vx+=Math.cos(ship.angle)*0.35; ship.vy+=Math.sin(ship.angle)*0.35; }
    else if (inp.back) { ship.vx-=Math.cos(ship.angle)*0.2; ship.vy-=Math.sin(ship.angle)*0.2; }

    if (inp.fire && ship.fireCd<=0) {
      const cd = ship.activeRapid>0 ? Math.floor(FIRE_CD*0.4) : FIRE_CD;
      ship.fireCd=cd; ship.shots++;
      fireBullet(room,ship);
      if (ship.activeTriple>0){ fireBullet(room,ship,-0.18); fireBullet(room,ship,0.18); }
    }

    for (let slot=0;slot<3;slot++) {
      if (inp['use'+(slot+1)] && ship.inventory[slot]) {
        const pu=ship.inventory.splice(slot,1)[0];
        if (pu==='shield') ship.activeShield=240;
        if (pu==='rapid')  ship.activeRapid=300;
        if (pu==='triple') ship.activeTriple=300;
        broadcastRoom(room,{type:'killMsg',msg:`${ship.name} activated ${pu.toUpperCase()}!`,color:puColor(pu)});
      }
    }
    for (let s=1;s<=3;s++) inp['use'+s]=false;

    ship.vx*=0.88; ship.vy*=0.88;
    const spd=Math.hypot(ship.vx,ship.vy);
    if (spd>SHIP_SPEED){ ship.vx=ship.vx/spd*SHIP_SPEED; ship.vy=ship.vy/spd*SHIP_SPEED; }
    ship.x+=ship.vx; ship.y+=ship.vy;
    if(ship.x<0)ship.x+=W; if(ship.x>W)ship.x-=W;
    if(ship.y<0)ship.y+=H; if(ship.y>H)ship.y-=H;

    for (let i=room.powerups.length-1;i>=0;i--) {
      if (ship.inventory.length>=3) break;
      if (dist(ship,room.powerups[i])<20) {
        ship.inventory.push(room.powerups[i].type);
        broadcastRoom(room,{type:'killMsg',msg:`${ship.name} picked up ${room.powerups[i].type.toUpperCase()}!`,color:puColor(room.powerups[i].type)});
        room.powerups.splice(i,1);
      }
    }
  }

  // ── BULLETS ──
  const surviving=[];
  for (const b of room.bullets) {
    b.x+=b.vx; b.y+=b.vy; b.life--;
    if(b.life<=0) continue;
    if(b.x<0)b.x+=W; if(b.x>W)b.x-=W;
    if(b.y<0)b.y+=H; if(b.y>H)b.y-=H;
    let hit=false;
    for (const ship of Object.values(room.ships)) {
      if(ship.dead||ship.id===b.ownerId) continue;
      if(dist(b,ship)<14){
        hit=true;
        if(!ship.activeShield){
          ship.hp-=BULLET_DMG;
          const atk=room.ships[b.ownerId];
          if(atk){ atk.streak++; if(atk.streak>=CONSEC_REQ){atk.hp=Math.min(MAX_HP,atk.hp+CONSEC_HEAL);atk.streak=0;broadcastRoom(room,{type:'killMsg',msg:`${atk.name} healed +${CONSEC_HEAL}! 🩹`});} }
          if(ship.hp<=0){
            ship.hp=0; ship.dead=true; ship.spectating=true;
            ship.respawnTimer=RESPAWN_TICKS;
            if(atk){ atk.kills++; broadcastRoom(room,{type:'killMsg',msg:`${atk.name} sank ${ship.name}! 💀`,color:'#ff4141'}); }
            broadcastRoom(room,{type:'sunk',id:ship.id,respawnIn:RESPAWN_TICKS/60});
          }
        }
        break;
      }
    }
    if(!hit) surviving.push(b);
  }
  room.bullets=surviving;

  // ── WIN CONDITION: last ship with kills > 0 OR only 1 left alive after everyone respawned once ──
  // We end only when exactly 1 player has never died AND all others are dead with no respawn
  // Simpler: end when only 1 alive AND at least one other has died this game
  const allShips = Object.values(room.ships);
  const alive    = allShips.filter(s=>!s.dead);
  const anyDied  = allShips.some(s=>s.kills>0||s.respawnTimer>0||s.spectating);
  if (alive.length<=1 && anyDied) {
    room.phase='ended';
    broadcastRoom(room,{type:'gameOver',winner:alive[0]?.name||null,winnerId:alive[0]?.id||null,ships:sanitizeShips(room)});
    stopTick(room);
    return;
  }

  broadcastRoom(room,{
    type:'state', frame:room.frame,
    ships:sanitizeShips(room),
    bullets:room.bullets.map(b=>({id:b.id,x:b.x,y:b.y,vx:b.vx,vy:b.vy})),
    powerups:room.powerups.map(p=>({id:p.id,x:p.x,y:p.y,type:p.type,life:p.life})),
  });
}

// ─── GAME CONTROL ─────────────────────────────────────
function startGame(room) {
  room.phase='playing'; room.frame=0; room.puTimer=0;
  room.bullets=[]; room.powerups=[];
  let ci=0; const count=Object.keys(room.ships).length;
  for (const ship of Object.values(room.ships)) {
    const angle=(ci/count)*Math.PI*2;
    ship.x=W/2+Math.cos(angle)*200; ship.y=H/2+Math.sin(angle)*200;
    ship.angle=angle+Math.PI; ship.vx=ship.vy=0;
    ship.hp=MAX_HP; ship.dead=false; ship.spectating=false; ship.respawnTimer=0;
    ship.kills=ship.shots=ship.streak=0;
    ship.fireCd=0; ship.inventory=[];
    ship.activeShield=ship.activeRapid=ship.activeTriple=0;
    ship.colorIdx=ci++;
  }
  broadcastRoom(room,{type:'start',ships:sanitizeShips(room)});
  startTick(room);
}

function resetToLobby(room) {
  room.phase='lobby'; room.bullets=[]; room.powerups=[];
  stopTick(room); broadcastLobby(room);
}

function startTick(room) {
  if(room.tickInterval) return;
  room.tickInterval=setInterval(()=>tick(room),1000/TICK_RATE);
}
function stopTick(room) {
  if(room.tickInterval){ clearInterval(room.tickInterval); room.tickInterval=null; }
}

// ─── WEBSOCKET ────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', ws => {
  let playerId=null, room=null;

  ws.on('message', raw => {
    let msg; try{ msg=JSON.parse(raw); }catch{ return; }

    if (msg.type==='join') {
      const code=(msg.code||'').toUpperCase().trim();
      room=rooms.get(code);
      if(!room){ ws.send(JSON.stringify({type:'error',msg:`Room "${code}" not found.`})); return; }
      if(room.phase==='playing'){ ws.send(JSON.stringify({type:'error',msg:'Game in progress. Wait for next round.'})); return; }
      if(Object.keys(room.ships).length>=MAX_PLAYERS){ ws.send(JSON.stringify({type:'error',msg:'Room is full!'})); return; }

      playerId='p_'+Date.now()+'_'+Math.random().toString(36).slice(2,6);
      const name=(msg.name||'CAPTAIN').toUpperCase().slice(0,12);
      room.ships[playerId]=makeShip(room,playerId,name);
      room.inputs[playerId]={};
      room.clients.set(ws,playerId);
      ws.send(JSON.stringify({type:'joined',id:playerId,code:room.code}));
      broadcastLobby(room);
    }

    else if (msg.type==='input') {
      if(!room||!playerId||!room.inputs[playerId]) return;
      const inp=room.inputs[playerId];
      inp.left=!!msg.left; inp.right=!!msg.right;
      inp.forward=!!msg.forward; inp.back=!!msg.back; inp.fire=!!msg.fire;
      if(msg.use1)inp.use1=true; if(msg.use2)inp.use2=true; if(msg.use3)inp.use3=true;
    }

    else if (msg.type==='startGame') {
      if(!room) return;
      if(Object.keys(room.ships).length>=MIN_PLAYERS) startGame(room);
    }

    else if (msg.type==='restartLobby') {
      if(!room) return;
      resetToLobby(room);
    }
  });

  ws.on('close', () => {
    if(!room||!playerId) return;
    delete room.ships[playerId];
    delete room.inputs[playerId];
    room.clients.delete(ws);
    if(room.clients.size===0){ destroyRoom(room); return; }
    if(room.phase==='playing'){
      const alive=Object.values(room.ships).filter(s=>!s.dead);
      if(alive.length<=1){
        room.phase='ended'; stopTick(room);
        broadcastRoom(room,{type:'gameOver',winner:alive[0]?.name||null,winnerId:alive[0]?.id||null,ships:sanitizeShips(room)});
      } else {
        broadcastRoom(room,{type:'killMsg',msg:'A captain abandoned ship!',color:'#ff4141'});
      }
    } else {
      broadcastLobby(room);
    }
  });
});

httpServer.listen(PORT, () => console.log(`Ocean War server running on port ${PORT}`));
