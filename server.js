const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ─── CONFIG ───────────────────────────────────────────
const PORT         = process.env.PORT || 3000;
const TICK_RATE    = 60;          // server ticks per second
const W            = 900;
const H            = 600;
const SHIP_SPEED   = 2.8;
const SHIP_TURN    = 0.045;
const BULLET_SPEED = 7;
const BULLET_LIFE  = 80;
const FIRE_CD      = 22;
const MAX_HP       = 100;
const BULLET_DMG   = 25;
const CONSEC_HEAL  = 20;
const CONSEC_REQ   = 3;
const PU_SPAWN_INT = 300;        // frames between power-up spawns
const MAX_PU       = 4;
const PU_LIFE      = 300;
const MIN_PLAYERS  = 2;
const MAX_PLAYERS  = 8;

// ─── HTTP SERVER (serves /public) ─────────────────────
const MIME = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

const httpServer = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'public',
    req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('Not found');
    } else {
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
      res.end(data);
    }
  });
});

// ─── GAME STATE ───────────────────────────────────────
let ships    = {};   // id → ship
let bullets  = [];
let powerups = [];
let particles= [];
let puTimer  = 0;
let frame    = 0;
let gamePhase= 'lobby';   // 'lobby' | 'playing' | 'ended'
let tickInterval = null;

let nextBulletId = 0;
let nextPuId     = 0;

const COLORS = [
  '#00cc33','#cc3300','#cc6600','#9900cc',
  '#0066cc','#cc0066','#00aacc','#aacc00',
];

function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx*dx + dy*dy);
}

function makeShip(id, name, colorIdx) {
  // Spread players around center
  const count = Object.keys(ships).length;
  const angle = (count / MAX_PLAYERS) * Math.PI * 2;
  const r     = 200;
  return {
    id, name, colorIdx,
    x: W/2 + Math.cos(angle) * r,
    y: H/2 + Math.sin(angle) * r,
    angle: angle + Math.PI,
    vx: 0, vy: 0,
    hp: MAX_HP,
    dead: false,
    kills: 0,
    shots: 0,
    streak: 0,
    fireCd: 0,
    inventory: [],
    activeShield: 0,
    activeRapid:  0,
    activeTriple: 0,
  };
}

function spawnPowerup() {
  const types = ['shield','rapid','triple'];
  powerups.push({
    id:   nextPuId++,
    x:    60 + Math.random() * (W - 120),
    y:    60 + Math.random() * (H - 120),
    type: types[Math.floor(Math.random() * types.length)],
    life: PU_LIFE,
  });
}

function fireBullet(ship, angleOff = 0) {
  const a = ship.angle + angleOff;
  bullets.push({
    id:      nextBulletId++,
    x:       ship.x + Math.cos(a) * 18,
    y:       ship.y + Math.sin(a) * 18,
    vx:      Math.cos(a) * BULLET_SPEED,
    vy:      Math.sin(a) * BULLET_SPEED,
    life:    BULLET_LIFE,
    ownerId: ship.id,
    hit:     false,
  });
}

// inputs keyed by player id: { left, right, forward, back, fire, use1, use2, use3 }
const inputs = {};

function tick() {
  if (gamePhase !== 'playing') return;
  frame++;
  puTimer++;

  // Spawn power-ups
  if (puTimer > PU_SPAWN_INT && powerups.length < MAX_PU) {
    spawnPowerup();
    puTimer = 0;
  }
  powerups = powerups.filter(p => --p.life > 0);

  // Update ships
  for (const ship of Object.values(ships)) {
    if (ship.dead) continue;

    const inp = inputs[ship.id] || {};

    if (ship.fireCd    > 0) ship.fireCd--;
    if (ship.activeShield > 0) ship.activeShield--;
    if (ship.activeRapid  > 0) ship.activeRapid--;
    if (ship.activeTriple > 0) ship.activeTriple--;

    // Movement
    if (inp.left)    ship.angle -= SHIP_TURN;
    if (inp.right)   ship.angle += SHIP_TURN;
    if (inp.forward) {
      ship.vx += Math.cos(ship.angle) * 0.35;
      ship.vy += Math.sin(ship.angle) * 0.35;
    } else if (inp.back) {
      ship.vx -= Math.cos(ship.angle) * 0.2;
      ship.vy -= Math.sin(ship.angle) * 0.2;
    }

    // Fire
    if (inp.fire && ship.fireCd <= 0) {
      const cd = ship.activeRapid > 0 ? Math.floor(FIRE_CD * 0.4) : FIRE_CD;
      ship.fireCd = cd;
      ship.shots++;
      fireBullet(ship);
      if (ship.activeTriple > 0) {
        fireBullet(ship, -0.18);
        fireBullet(ship,  0.18);
      }
    }

    // Use power-up slots
    for (let slot = 0; slot < 3; slot++) {
      if (inp['use' + (slot+1)] && ship.inventory[slot]) {
        const pu = ship.inventory.splice(slot, 1)[0];
        if (pu === 'shield') ship.activeShield = 240;
        if (pu === 'rapid')  ship.activeRapid  = 300;
        if (pu === 'triple') ship.activeTriple = 300;
        broadcast({ type: 'killMsg', msg: `${ship.name} activated ${pu.toUpperCase()}!`, color: puColor(pu) });
      }
    }
    // clear use flags
    for (let s = 1; s <= 3; s++) inp['use'+s] = false;

    // Physics
    ship.vx *= 0.88; ship.vy *= 0.88;
    const spd = Math.sqrt(ship.vx**2 + ship.vy**2);
    if (spd > SHIP_SPEED) { ship.vx = ship.vx/spd*SHIP_SPEED; ship.vy = ship.vy/spd*SHIP_SPEED; }
    ship.x += ship.vx; ship.y += ship.vy;

    // Wrap
    if (ship.x < 0) ship.x += W; if (ship.x > W) ship.x -= W;
    if (ship.y < 0) ship.y += H; if (ship.y > H) ship.y -= H;

    // Power-up pickup
    for (let i = powerups.length - 1; i >= 0; i--) {
      if (ship.inventory.length >= 3) break;
      if (dist(ship, powerups[i]) < 20) {
        ship.inventory.push(powerups[i].type);
        broadcast({ type: 'killMsg', msg: `${ship.name} picked up ${powerups[i].type.toUpperCase()}!`, color: puColor(powerups[i].type) });
        powerups.splice(i, 1);
      }
    }
  }

  // Update bullets
  const surviving = [];
  for (const b of bullets) {
    if (b.hit) continue;
    b.x += b.vx; b.y += b.vy;
    b.life--;
    if (b.life <= 0) { b.hit = true; continue; }
    if (b.x < 0) b.x += W; if (b.x > W) b.x -= W;
    if (b.y < 0) b.y += H; if (b.y > H) b.y -= H;

    let hit = false;
    for (const ship of Object.values(ships)) {
      if (ship.dead || ship.id === b.ownerId) continue;
      if (dist(b, ship) < 14) {
        hit = true;
        if (ship.activeShield > 0) {
          // blocked
        } else {
          ship.hp -= BULLET_DMG;
          const attacker = ships[b.ownerId];
          if (attacker) {
            attacker.streak++;
            if (attacker.streak >= CONSEC_REQ) {
              attacker.hp = Math.min(MAX_HP, attacker.hp + CONSEC_HEAL);
              attacker.streak = 0;
              broadcast({ type: 'killMsg', msg: `${attacker.name} healed +${CONSEC_HEAL}! 🩹` });
            }
          }
          if (ship.hp <= 0) {
            ship.hp   = 0;
            ship.dead = true;
            if (attacker) {
              attacker.kills++;
              broadcast({ type: 'killMsg', msg: `${attacker.name} sank ${ship.name}! 💀`, color: '#ff4141' });
            }
          }
        }
        break;
      }
    }
    if (!hit) surviving.push(b);
  }
  bullets = surviving;

  // Check win condition
  const alive = Object.values(ships).filter(s => !s.dead);
  if (alive.length === 1) {
    gamePhase = 'ended';
    broadcast({ type: 'gameOver', winner: alive[0].name, winnerId: alive[0].id, ships: sanitizeShips() });
    stopTick();
    return;
  }
  if (alive.length === 0) {
    gamePhase = 'ended';
    broadcast({ type: 'gameOver', winner: null, ships: sanitizeShips() });
    stopTick();
    return;
  }

  // Broadcast state
  broadcast({
    type:     'state',
    frame,
    ships:    sanitizeShips(),
    bullets:  bullets.map(b => ({ id:b.id, x:b.x, y:b.y, hit:b.hit })),
    powerups: powerups.map(p => ({ id:p.id, x:p.x, y:p.y, type:p.type, life:p.life })),
  });
}

function sanitizeShips() {
  return Object.values(ships).map(s => ({
    id: s.id, name: s.name, colorIdx: s.colorIdx,
    x: s.x, y: s.y, angle: s.angle, vx: s.vx, vy: s.vy,
    hp: s.hp, dead: s.dead,
    kills: s.kills, shots: s.shots, streak: s.streak,
    inventory: s.inventory,
    activeShield: s.activeShield, activeRapid: s.activeRapid, activeTriple: s.activeTriple,
  }));
}

function puColor(type) {
  return { shield:'#44aaff', rapid:'#ffaa00', triple:'#ff44aa' }[type] || '#ffffff';
}

function startGame() {
  gamePhase = 'playing';
  frame = 0; puTimer = 0;
  bullets = []; powerups = [];
  // Reset ship stats but keep positions
  const colorPool = [...COLORS];
  let ci = 0;
  for (const ship of Object.values(ships)) {
    const count = Object.keys(ships).length;
    const idx   = ci++;
    const angle = (idx / count) * Math.PI * 2;
    ship.x = W/2 + Math.cos(angle) * 200;
    ship.y = H/2 + Math.sin(angle) * 200;
    ship.angle = angle + Math.PI;
    ship.vx = ship.vy = 0;
    ship.hp = MAX_HP; ship.dead = false;
    ship.kills = ship.shots = ship.streak = 0;
    ship.fireCd = 0; ship.inventory = [];
    ship.activeShield = ship.activeRapid = ship.activeTriple = 0;
    ship.colorIdx = idx;
  }
  broadcast({ type: 'start', ships: sanitizeShips() });
  startTick();
}

function resetToLobby() {
  gamePhase = 'lobby';
  bullets = []; powerups = [];
  stopTick();
  broadcastLobby();
}

function startTick() {
  if (tickInterval) return;
  tickInterval = setInterval(tick, 1000 / TICK_RATE);
}
function stopTick() {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
}

// ─── WEBSOCKET ────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });
const clients = new Map(); // ws → playerId

let nextColorIdx = 0;

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

function broadcastLobby() {
  broadcast({
    type:       'lobby',
    players:    Object.values(ships).map(s => ({ id: s.id, name: s.name, colorIdx: s.colorIdx })),
    minPlayers: MIN_PLAYERS,
    gamePhase,
  });
}

wss.on('connection', ws => {
  let playerId = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      playerId = msg.id || ('p_' + Date.now() + '_' + Math.random().toString(36).slice(2,6));
      const name = (msg.name || 'CAPTAIN').toUpperCase().slice(0, 12);

      if (Object.keys(ships).length >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ type: 'error', msg: 'Game is full!' }));
        return;
      }
      // If game is in progress, reject
      if (gamePhase === 'playing') {
        ws.send(JSON.stringify({ type: 'error', msg: 'Game already in progress. Wait for next round.' }));
        return;
      }

      ships[playerId]  = makeShip(playerId, name, nextColorIdx++ % COLORS.length);
      inputs[playerId] = {};
      clients.set(ws, playerId);

      // Send the joining player their own id
      ws.send(JSON.stringify({ type: 'joined', id: playerId, color: COLORS[ships[playerId].colorIdx] }));
      broadcastLobby();
    }

    else if (msg.type === 'input') {
      if (!playerId || !inputs[playerId]) return;
      const inp = inputs[playerId];
      inp.left    = !!msg.left;
      inp.right   = !!msg.right;
      inp.forward = !!msg.forward;
      inp.back    = !!msg.back;
      inp.fire    = !!msg.fire;
      if (msg.use1) inp.use1 = true;
      if (msg.use2) inp.use2 = true;
      if (msg.use3) inp.use3 = true;
    }

    else if (msg.type === 'startGame') {
      if (Object.keys(ships).length >= MIN_PLAYERS) startGame();
    }

    else if (msg.type === 'restartLobby') {
      resetToLobby();
    }
  });

  ws.on('close', () => {
    if (!playerId) return;
    delete ships[playerId];
    delete inputs[playerId];
    clients.delete(ws);
    nextColorIdx = Math.max(0, nextColorIdx - 1);

    if (gamePhase === 'playing') {
      const alive = Object.values(ships).filter(s => !s.dead);
      if (alive.length <= 1) {
        gamePhase = 'ended';
        stopTick();
        broadcast({ type: 'gameOver', winner: alive[0]?.name || null, winnerId: alive[0]?.id || null, ships: sanitizeShips() });
      } else {
        broadcast({ type: 'killMsg', msg: `A player disconnected!`, color: '#ff4141' });
      }
    } else {
      broadcastLobby();
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Ship Battle server running on port ${PORT}`);
});
