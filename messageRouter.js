const config = require('./config');

class MessageRouter {
  constructor(roomManager, throttle) {
    this.roomManager = roomManager;
    this.throttle = throttle;
  }

  handleGodotMessage(ws, msg) {
    const type = msg.type;

    switch (type) {
      case 'create_room':
        this._handleCreateRoom(ws);
        break;
      case 'start':
        this._handleGodotStart(ws, msg);
        break;
      case 'race_results':
        this._handleRaceResults(ws, msg);
        break;
      case 'godot_reconnect':
        this._handleGodotReconnect(ws, msg);
        break;
      default:
        this._sendError(ws, 'malformed_message', [`unknown type: ${type}`]);
    }
  }

  handleControllerMessage(ws, msg) {
    const type = msg.type;

    switch (type) {
      case 'join':
        this._handleJoin(ws, msg);
        break;
      case 'rejoin':
        this._handleRejoin(ws, msg);
        break;
      case 'press':
        this._handlePress(ws, msg);
        break;
      case 'start':
        this._handleControllerStart(ws, msg);
        break;
      default:
        this._sendError(ws, 'malformed_message', [`unknown type: ${type}`]);
    }
  }

  _handleCreateRoom(ws) {
    // Clean up any old room associated with this Godot client
    this.roomManager.removeRoomByGodotWs(ws);

    const result = this.roomManager.createRoom(ws);
    if (result.error) {
      ws.send(JSON.stringify({ type: 'error', message: result.error }));
    }
    // Update ws.roomCode so future disconnections find the right room
    if (result.roomCode) {
      ws.roomCode = result.roomCode;
    }
  }

  _handleGodotStart(ws, msg) {
    if (!this._validateFields(ws, msg, ['roomCode'])) return;
    const roomCode = msg.roomCode;
    const room = this.roomManager.getRoom(roomCode);
    if (!room) {
      this._sendError(ws, 'invalid_room');
      return;
    }

    this.roomManager.transitionState(roomCode, 'COUNTDOWN');

    setTimeout(() => {
      const currentRoom = this.roomManager.getRoom(roomCode);
      if (currentRoom && currentRoom.state === 'COUNTDOWN') {
        this.roomManager.transitionState(roomCode, 'RACING');
      }
    }, config.COUNTDOWN_SECONDS * 1000);
  }

  _handleControllerStart(ws, msg) {
    if (!this._validateFields(ws, msg, ['roomCode', 'playerId'])) return;

    const { roomCode, playerId } = msg;
    const room = this.roomManager.getRoom(roomCode);
    if (!room) {
      this._sendError(ws, 'invalid_room');
      return;
    }

    if (!this.roomManager.validateHost(roomCode, playerId)) {
      this._sendError(ws, 'not_host');
      return;
    }

    if (room.state !== 'READY' && room.state !== 'WAITING') {
      this._sendError(ws, 'invalid_state');
      return;
    }

    this.roomManager.transitionState(roomCode, 'COUNTDOWN');

    setTimeout(() => {
      const currentRoom = this.roomManager.getRoom(roomCode);
      if (currentRoom && currentRoom.state === 'COUNTDOWN') {
        this.roomManager.transitionState(roomCode, 'RACING');
      }
    }, config.COUNTDOWN_SECONDS * 1000);
  }

  _handleGodotReconnect(ws, msg) {
    if (!this._validateFields(ws, msg, ['roomCode'])) return;
    const result = this.roomManager.reconnectGodot(msg.roomCode, ws);
    if (result.error) {
      this._sendError(ws, result.error);
    }
  }

  _handleRaceResults(ws, msg) {
    if (!this._validateFields(ws, msg, ['roomCode'])) return;
    const roomCode = msg.roomCode;
    const room = this.roomManager.getRoom(roomCode);
    if (!room) return;

    const resultMsg = {
      type: 'result',
      rankings: msg.rankings || [],
    };
    this.roomManager._broadcastToControllers(room, resultMsg, null);

    this.roomManager.transitionState(roomCode, 'FINISHED');
  }

  _handleJoin(ws, msg) {
    if (!this._validateFields(ws, msg, ['roomCode', 'playerName'])) return;

    const carId = parseInt(msg.carId, 10) || 1;
    const result = this.roomManager.joinRoom(msg.roomCode, msg.playerName, ws, carId);
    if (result.error) {
      this._sendError(ws, result.error);
    }
  }

  _handleRejoin(ws, msg) {
    if (!this._validateFields(ws, msg, ['roomCode', 'playerId'])) return;

    const result = this.roomManager.rejoinRoom(msg.roomCode, msg.playerId, ws);
    if (result.error) {
      this._sendError(ws, result.error);
    }
  }

  _handlePress(ws, msg) {
    if (!this._validateFields(ws, msg, ['roomCode', 'playerId'])) return;

    const { roomCode, playerId } = msg;
    const room = this.roomManager.getRoom(roomCode);
    if (!room) {
      this._sendError(ws, 'invalid_room');
      return;
    }

    if (room.state !== 'RACING') {
      this._sendError(ws, 'not_racing');
      return;
    }

    const player = room.players.get(playerId);
    if (!player || player.ws !== ws) {
      this._sendError(ws, 'invalid_player');
      return;
    }

    if (!this.throttle.allowPress(playerId)) {
      ws.send(JSON.stringify({ type: 'press_ack', accepted: false, reason: 'throttled' }));
      return;
    }

    ws.send(JSON.stringify({ type: 'press_ack', accepted: true }));

    const seqId = this.roomManager.getNextSequenceId(roomCode);
    const pressMsg = {
      type: 'press',
      playerId,
      server_timestamp: new Date().toISOString(),
      server_sequence_id: seqId,
    };
    this.roomManager._sendToGodot(room, pressMsg);
  }

  _validateFields(ws, msg, requiredFields) {
    const missing = [];
    for (const field of requiredFields) {
      if (msg[field] === undefined || msg[field] === null || msg[field] === '') {
        missing.push(field);
      }
    }
    if (missing.length > 0) {
      this._sendError(ws, 'malformed_message', missing);
      return false;
    }
    return true;
  }

  _sendError(ws, message, missing) {
    const error = { type: 'error', message };
    if (missing && missing.length > 0) {
      error.missing = missing;
    }
    ws.send(JSON.stringify(error));
  }
}

module.exports = MessageRouter;