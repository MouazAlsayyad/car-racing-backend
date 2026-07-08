const config = require('../config');

let kv = null;
try {
  const { createClient } = require('@vercel/kv');
  if (process.env.KV_URL && process.env.KV_REST_API_TOKEN) {
    kv = createClient({
      url: process.env.KV_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
  }
} catch {
  // @vercel/kv not installed or not in production — running locally or in tests
}

const ValidTransitions = {
  WAITING: ['READY'],
  READY: ['COUNTDOWN', 'RACING'],
  COUNTDOWN: ['RACING'],
  RACING: ['FINISHED'],
  FINISHED: ['WAITING'],
};

class RoomManagerKv {
  constructor() {
    this.rooms = new Map();
    this._playerIdCounter = new Map();
  }

  async init() {
    if (!kv) return;
    try {
      const keys = await kv.keys('room:*');
      const roomCodes = new Set();
      for (const key of keys) {
        const match = key.match(/^room:([A-Z0-9]+)$/);
        if (match) roomCodes.add(match[1]);
      }
      for (const code of roomCodes) {
        try {
          const roomData = await kv.hgetall(`room:${code}`);
          if (!roomData) continue;
          const playerIds = await kv.smembers(`room:${code}:players`);
          const players = new Map();
          for (const pid of playerIds) {
            const pData = await kv.hgetall(`room:${code}:player:${pid}`);
            if (pData) {
              players.set(pid, {
                name: pData.name || '',
                isHost: pData.isHost === 'true' || pData.isHost === true,
                carId: parseInt(pData.carId, 10) || 1,
                joinOrder: parseInt(pData.joinOrder, 10) || 0,
                distance: parseFloat(pData.distance) || 0,
                reservedUntil: null,
                ws: null,
              });
            }
          }
          this.rooms.set(code, {
            code,
            state: roomData.state || 'WAITING',
            hostPlayerId: roomData.hostPlayerId || null,
            players,
            godotWs: null,
            sequenceId: parseInt(roomData.sequenceId, 10) || 0,
            nextPlayerNum: parseInt(roomData.nextPlayerNum, 10) || (players.size + 1),
          });
          this._playerIdCounter.set(code, this.rooms.get(code).nextPlayerNum);
        } catch (e) {
          console.error(`Failed to load room ${code} from KV:`, e.message);
        }
      }
      if (roomCodes.size > 0) {
        console.log(`RoomManagerKv: Loaded ${roomCodes.size} room(s) from KV`);
      }
    } catch (e) {
      console.error('RoomManagerKv.init: Failed to load from KV:', e.message);
    }
  }

  generateRoomCode() {
    const chars = config.ROOM_CODE_CHARS;
    for (let attempt = 0; attempt < config.ROOM_CODE_MAX_RETRIES; attempt++) {
      let code = '';
      for (let i = 0; i < config.ROOM_CODE_LENGTH; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
      }
      if (!this.rooms.has(code)) {
        return code;
      }
    }
    return null;
  }

  createRoom(godotWs) {
    const code = this.generateRoomCode();
    if (code === null) {
      return { error: 'room_code_unavailable' };
    }
    const room = {
      code,
      state: 'WAITING',
      hostPlayerId: null,
      players: new Map(),
      godotWs,
      sequenceId: 0,
      nextPlayerNum: 1,
    };
    this.rooms.set(code, room);
    this._playerIdCounter.set(code, 1);
    this._sendToGodot(room, { type: 'room_created', roomCode: code });
    this._kvPersistRoom(room);
    return { roomCode: code, room };
  }

  joinRoom(roomCode, playerName, controllerWs, carId) {
    if (controllerWs.roomCode && controllerWs.roomCode !== roomCode) {
      const oldRoom = this.rooms.get(controllerWs.roomCode);
      if (oldRoom) {
        const oldPlayerId = controllerWs.playerId;
        if (oldPlayerId && oldRoom.players.has(oldPlayerId)) {
          const wasHost = oldRoom.players.get(oldPlayerId).isHost;
          oldRoom.players.delete(oldPlayerId);
          this._kvDeletePlayer(oldRoom.code, oldPlayerId);
          if (wasHost && oldRoom.players.size > 0) {
            this.promoteNextHost(oldRoom);
          }
          if (oldRoom.state === 'READY' && oldRoom.players.size < config.MIN_PLAYERS) {
            const oldRoomCode = controllerWs.roomCode;
            this.transitionState(oldRoomCode, 'WAITING');
          }
          this._broadcastPlayerList(oldRoom);
        }
      }
    }

    const room = this.rooms.get(roomCode);
    if (!room) {
      return { error: 'invalid_room' };
    }
    if (room.players.size >= config.MAX_PLAYERS) {
      return { error: 'room_full' };
    }
    if (room.state === 'RACING' || room.state === 'FINISHED') {
      return { error: 'race_in_progress' };
    }

    const assignedCarId = this._assignCar(room, carId);
    const playerId = 'player_' + room.nextPlayerNum;
    room.nextPlayerNum++;

    const isHost = room.players.size === 0;
    const playerObj = {
      name: playerName,
      isHost,
      carId: assignedCarId,
      ws: controllerWs,
      joinOrder: room.players.size,
      reservedUntil: null,
    };
    room.players.set(playerId, playerObj);

    if (isHost) {
      room.hostPlayerId = playerId;
    }

    controllerWs.playerId = playerId;
    controllerWs.roomCode = roomCode;

    this._sendToController(controllerWs, {
      type: 'joined',
      playerId,
      roomCode,
      isHost,
      carId: assignedCarId,
    });

    this._broadcastPlayerList(room);

    const totalPlayers = room.players.size;
    const playerJoinedMsg = {
      type: 'player_joined',
      playerId,
      playerName,
      carId: assignedCarId,
      totalPlayers,
    };
    this._sendToGodot(room, playerJoinedMsg);
    this._broadcastToControllers(room, playerJoinedMsg, null);

    if (room.state === 'WAITING' && totalPlayers >= config.MIN_PLAYERS) {
      this.transitionState(roomCode, 'READY');
    }

    this._kvPersistRoom(room);
    this._kvPersistPlayer(roomCode, playerId, playerObj);

    return { playerId, isHost, carId: assignedCarId };
  }

  _assignCar(room, requestedCarId) {
    const taken = new Set();
    for (const [, player] of room.players) {
      if (player.carId) taken.add(player.carId);
    }
    if (requestedCarId >= 1 && requestedCarId <= config.AVAILABLE_CARS && !taken.has(requestedCarId)) {
      return requestedCarId;
    }
    for (let i = 1; i <= config.AVAILABLE_CARS; i++) {
      if (!taken.has(i)) return i;
    }
    return 1;
  }

  rejoinRoom(roomCode, playerId, ws) {
    const room = this.rooms.get(roomCode);
    if (!room) {
      return { error: 'invalid_room' };
    }
    const player = room.players.get(playerId);
    if (!player) {
      return { error: 'invalid_player' };
    }

    if (player.reservedUntil) {
      const now = Date.now();
      if (now > player.reservedUntil) {
        room.players.delete(playerId);
        this._kvDeletePlayer(roomCode, playerId);
        return { error: 'reservation_expired' };
      }
    }

    player.ws = ws;
    player.reservedUntil = null;
    ws.playerId = playerId;
    ws.roomCode = roomCode;

    this._sendToController(ws, {
      type: 'joined',
      playerId,
      roomCode,
      isHost: player.isHost,
      carId: player.carId,
    });

    const snapshot = this.buildSnapshot(room);
    this._sendToController(ws, snapshot);
    this._broadcastPlayerList(room);

    return { playerId, isHost: player.isHost };
  }

  removePlayer(playerId) {
    for (const [roomCode, room] of this.rooms) {
      const player = room.players.get(playerId);
      if (!player) continue;

      const wasHost = player.isHost;
      room.players.delete(playerId);
      this._kvDeletePlayer(roomCode, playerId);

      this._sendToGodot(room, { type: 'player_left', playerId });
      this._broadcastToControllers(room, { type: 'player_left', playerId }, null);

      if (wasHost && room.players.size > 0 &&
          (room.state === 'WAITING' || room.state === 'READY' || room.state === 'COUNTDOWN')) {
        this.promoteNextHost(room);
      }

      if (room.state === 'READY' && room.players.size < config.MIN_PLAYERS) {
        this.transitionState(roomCode, 'WAITING');
      }

      this._broadcastPlayerList(room);
      this._kvPersistRoom(room);
      return;
    }
  }

  reservePlayer(playerId) {
    for (const [, room] of this.rooms) {
      const player = room.players.get(playerId);
      if (player) {
        player.reservedUntil = Date.now() + config.PLAYER_ID_RESERVE_SECONDS * 1000;
        player.ws = null;
        return;
      }
    }
  }

  promoteNextHost(room) {
    let nextHost = null;
    let lowestOrder = Infinity;
    for (const [playerId, player] of room.players) {
      if (player.joinOrder < lowestOrder) {
        lowestOrder = player.joinOrder;
        nextHost = playerId;
      }
    }
    if (nextHost) {
      for (const [, player] of room.players) {
        player.isHost = false;
      }
      room.players.get(nextHost).isHost = true;
      room.hostPlayerId = nextHost;

      const msg = { type: 'player_promoted', playerId: nextHost };
      this._sendToGodot(room, msg);
      this._broadcastToControllers(room, msg, null);
      this._kvPersistRoom(room);
    }
  }

  getRoom(roomCode) {
    return this.rooms.get(roomCode) || null;
  }

  buildSnapshot(room) {
    const playerDistances = {};
    for (const [playerId, player] of room.players) {
      playerDistances[playerId] = player.distance || 0;
    }
    return {
      type: 'room_snapshot',
      playerDistances,
      server_snapshot_timestamp: new Date().toISOString(),
    };
  }

  transitionState(roomCode, newState) {
    const room = this.rooms.get(roomCode);
    if (!room) return false;

    const allowed = ValidTransitions[room.state];
    if (!allowed || !allowed.includes(newState)) {
      return false;
    }

    room.state = newState;

    const stateMsg = { type: 'state_change', state: newState };
    this._sendToGodot(room, stateMsg);
    this._broadcastToControllers(room, stateMsg, null);

    if (newState === 'RACING') {
      this._broadcastToControllers(room, { type: 'game_start' }, null);
    }

    this._kvPersistRoom(room);
    return true;
  }

  validateHost(roomCode, playerId) {
    const room = this.rooms.get(roomCode);
    if (!room) return false;
    const player = room.players.get(playerId);
    if (!player) return false;
    return player.isHost;
  }

  getNextSequenceId(roomCode) {
    const room = this.rooms.get(roomCode);
    if (!room) return 0;
    room.sequenceId++;
    this._kvPersistRoom(room);
    return room.sequenceId;
  }

  reconnectGodot(roomCode, ws) {
    const room = this.rooms.get(roomCode);
    if (!room) {
      return { error: 'invalid_room' };
    }
    room.godotWs = ws;
    ws.roomCode = roomCode;
    ws.tag = 'godot';

    const snapshot = this.buildSnapshot(room);
    this._sendToGodot(room, snapshot);

    const playerList = [];
    for (const [playerId, player] of room.players) {
      playerList.push({ id: playerId, name: player.name, isHost: player.isHost });
    }
    this._sendToGodot(room, { type: 'player_list', players: playerList });

    if (room.state === 'RACING' || room.state === 'COUNTDOWN') {
      this._sendToGodot(room, { type: 'state_change', state: room.state });
    }

    return { roomCode };
  }

  removeRoom(roomCode) {
    const room = this.rooms.get(roomCode);
    if (room) {
      this._notifyRoomClosed(room);
    }
    this.rooms.delete(roomCode);
    this._playerIdCounter.delete(roomCode);
    this._kvDeleteRoom(roomCode);
  }

  removeRoomByGodotWs(ws) {
    for (const [roomCode, room] of this.rooms) {
      if (room.godotWs === ws) {
        this._notifyRoomClosed(room);
        this.rooms.delete(roomCode);
        this._playerIdCounter.delete(roomCode);
        this._kvDeleteRoom(roomCode);
        return roomCode;
      }
    }
    return null;
  }

  _sendToGodot(room, msg) {
    if (room.godotWs && room.godotWs.readyState === 1) {
      room.godotWs.send(JSON.stringify(msg));
    }
  }

  _sendToController(ws, msg) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
    }
  }

  _broadcastToControllers(room, msg, excludeWs) {
    const data = JSON.stringify(msg);
    for (const [, player] of room.players) {
      if (player.ws && player.ws !== excludeWs && player.ws.readyState === 1) {
        player.ws.send(data);
      }
    }
  }

  _broadcastPlayerList(room) {
    const players = [];
    for (const [playerId, player] of room.players) {
      players.push({
        id: playerId,
        name: player.name,
        isHost: player.isHost,
        carId: player.carId,
      });
    }
    const msg = { type: 'player_list', players };
    this._broadcastToControllers(room, msg, null);
  }

  _notifyRoomClosed(room) {
    const msg = { type: 'room_closed' };
    this._broadcastToControllers(room, msg, null);
  }

  // --- KV Persistence (fire-and-forget) ---

  _kvPersistRoom(room) {
    if (!kv) return;
    const code = room.code;
    kv.hset(`room:${code}`, {
      state: room.state,
      hostPlayerId: room.hostPlayerId || '',
      nextPlayerNum: room.nextPlayerNum,
      sequenceId: room.sequenceId,
      createdAt: Date.now(),
    }).catch(() => {});
    kv.expire(`room:${code}`, 1800).catch(() => {});
    if (room.players.size > 0) {
      const playerIds = Array.from(room.players.keys());
      kv.sadd(`room:${code}:players`, ...playerIds).catch(() => {});
      kv.expire(`room:${code}:players`, 1800).catch(() => {});
    }
  }

  _kvPersistPlayer(roomCode, playerId, player) {
    if (!kv) return;
    kv.hset(`room:${roomCode}:player:${playerId}`, {
      name: player.name,
      isHost: player.isHost ? 'true' : 'false',
      carId: player.carId,
      joinOrder: player.joinOrder,
      distance: player.distance || 0,
    }).catch(() => {});
    kv.expire(`room:${roomCode}:player:${playerId}`, 1800).catch(() => {});
  }

  _kvDeletePlayer(roomCode, playerId) {
    if (!kv) return;
    kv.srem(`room:${roomCode}:players`, playerId).catch(() => {});
    kv.del(`room:${roomCode}:player:${playerId}`).catch(() => {});
  }

  _kvDeleteRoom(roomCode) {
    if (!kv) return;
    const room = this.rooms.get(roomCode);
    if (room) {
      for (const playerId of room.players.keys()) {
        kv.del(`room:${roomCode}:player:${playerId}`).catch(() => {});
      }
    }
    kv.del(`room:${roomCode}:players`).catch(() => {});
    kv.del(`room:${roomCode}`).catch(() => {});
  }
}

module.exports = RoomManagerKv;
