const config = require('./config');

const ValidTransitions = {
  WAITING: ['READY'],
  READY: ['COUNTDOWN', 'RACING'],
  COUNTDOWN: ['RACING'],
  RACING: ['FINISHED'],
  FINISHED: ['WAITING'],
};

class RoomManager {
  constructor() {
    this.rooms = new Map();
    this._playerIdCounter = new Map();
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
      players: new Map(),
      godotWs,
      sequenceId: 0,
      nextPlayerNum: 1,
    };
    this.rooms.set(code, room);
    this._playerIdCounter.set(code, 1);
    this._sendToGodot(room, { type: 'room_created', roomCode: code });
    return { roomCode: code, room };
  }

  joinRoom(roomCode, playerName, controllerWs, carId) {
    // Remove player from any previous room before joining new one
    if (controllerWs.roomCode && controllerWs.roomCode !== roomCode) {
      const oldRoom = this.rooms.get(controllerWs.roomCode);
      if (oldRoom) {
        const oldPlayerId = controllerWs.playerId;
        if (oldPlayerId && oldRoom.players.has(oldPlayerId)) {
          const wasHost = oldRoom.players.get(oldPlayerId).isHost;
          oldRoom.players.delete(oldPlayerId);
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

      this._sendToGodot(room, {
        type: 'player_left',
        playerId,
      });

      this._broadcastToControllers(room, {
        type: 'player_left',
        playerId,
      }, null);

      if (wasHost && room.players.size > 0 &&
          (room.state === 'WAITING' || room.state === 'READY' || room.state === 'COUNTDOWN')) {
        this.promoteNextHost(room);
      }

      if (room.state === 'READY' && room.players.size < config.MIN_PLAYERS) {
        this.transitionState(roomCode, 'WAITING');
      }

      this._broadcastPlayerList(room);
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

      const msg = { type: 'player_promoted', playerId: nextHost };
      this._sendToGodot(room, msg);
      this._broadcastToControllers(room, msg, null);
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
  }

  removeRoomByGodotWs(ws) {
    for (const [roomCode, room] of this.rooms) {
      if (room.godotWs === ws) {
        this._notifyRoomClosed(room);
        this.rooms.delete(roomCode);
        this._playerIdCounter.delete(roomCode);
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
}

module.exports = RoomManager;