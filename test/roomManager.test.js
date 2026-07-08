const RoomManager = require('../roomManager');

function mockWs() {
  const messages = [];
  return {
    readyState: 1,
    send: (data) => messages.push(JSON.parse(data)),
    messages,
    playerId: null,
    roomCode: null,
    tag: null,
  };
}

describe('RoomManager', () => {
  let rm;

  beforeEach(() => {
    rm = new RoomManager();
  });

  describe('createRoom', () => {
    test('creates a room with a unique code', () => {
      const ws = mockWs();
      const result = rm.createRoom(ws);
      expect(result.roomCode).toBeDefined();
      expect(result.roomCode.length).toBe(4);
      expect(result.error).toBeUndefined();
    });

    test('sends room_created to godot client', () => {
      const ws = mockWs();
      rm.createRoom(ws);
      const msg = ws.messages.find((m) => m.type === 'room_created');
      expect(msg).toBeDefined();
      expect(msg.roomCode).toBeDefined();
    });

    test('room starts in WAITING state', () => {
      const ws = mockWs();
      const result = rm.createRoom(ws);
      const room = rm.getRoom(result.roomCode);
      expect(room.state).toBe('WAITING');
    });
  });

  describe('joinRoom', () => {
    let roomCode;
    let godotWs;

    beforeEach(() => {
      godotWs = mockWs();
      const result = rm.createRoom(godotWs);
      roomCode = result.roomCode;
    });

    test('first player becomes host', () => {
      const ws = mockWs();
      const result = rm.joinRoom(roomCode, 'Alice', ws);
      expect(result.playerId).toBe('player_1');
      expect(result.isHost).toBe(true);
    });

    test('second player is not host', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      rm.joinRoom(roomCode, 'Alice', ws1);
      const result = rm.joinRoom(roomCode, 'Bob', ws2);
      expect(result.playerId).toBe('player_2');
      expect(result.isHost).toBe(false);
    });

    test('returns error for invalid room code', () => {
      const ws = mockWs();
      const result = rm.joinRoom('ZZZZ', 'Alice', ws);
      expect(result.error).toBe('invalid_room');
    });

    test('transitions to READY when MIN_PLAYERS reached', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      rm.joinRoom(roomCode, 'Alice', ws1);
      rm.joinRoom(roomCode, 'Bob', ws2);
      const room = rm.getRoom(roomCode);
      expect(room.state).toBe('READY');
    });

    test('rejects join when room is full', () => {
      const players = [];
      for (let i = 0; i < 4; i++) {
        const ws = mockWs();
        rm.joinRoom(roomCode, `Player${i}`, ws);
        players.push(ws);
      }
      const ws5 = mockWs();
      const result = rm.joinRoom(roomCode, 'Extra', ws5);
      expect(result.error).toBe('room_full');
    });

    test('rejects join during RACING state', () => {
      rm.transitionState(roomCode, 'READY');
      rm.transitionState(roomCode, 'COUNTDOWN');
      rm.transitionState(roomCode, 'RACING');
      const ws = mockWs();
      const result = rm.joinRoom(roomCode, 'Late', ws);
      expect(result.error).toBe('race_in_progress');
    });
  });

  describe('state transitions', () => {
    let roomCode;

    beforeEach(() => {
      const ws = mockWs();
      const result = rm.createRoom(ws);
      roomCode = result.roomCode;
    });

    test('WAITING -> READY is valid', () => {
      expect(rm.transitionState(roomCode, 'READY')).toBe(true);
    });

    test('WAITING -> RACING is invalid', () => {
      expect(rm.transitionState(roomCode, 'RACING')).toBe(false);
    });

    test('READY -> COUNTDOWN -> RACING -> FINISHED full chain', () => {
      rm.transitionState(roomCode, 'READY');
      rm.transitionState(roomCode, 'COUNTDOWN');
      expect(rm.getRoom(roomCode).state).toBe('COUNTDOWN');
      rm.transitionState(roomCode, 'RACING');
      expect(rm.getRoom(roomCode).state).toBe('RACING');
      rm.transitionState(roomCode, 'FINISHED');
      expect(rm.getRoom(roomCode).state).toBe('FINISHED');
    });

    test('broadcasts state_change messages', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      rm.joinRoom(roomCode, 'Alice', ws1);
      rm.joinRoom(roomCode, 'Bob', ws2);

      rm.transitionState(roomCode, 'READY');

      const stateChanges = ws1.messages.filter((m) => m.type === 'state_change');
      expect(stateChanges.length).toBeGreaterThan(0);
    });
  });

  describe('host promotion', () => {
    let roomCode;
    let ws1, ws2;

    beforeEach(() => {
      const godotWs = mockWs();
      const result = rm.createRoom(godotWs);
      roomCode = result.roomCode;
      ws1 = mockWs();
      ws2 = mockWs();
      rm.joinRoom(roomCode, 'Alice', ws1);
      rm.joinRoom(roomCode, 'Bob', ws2);
    });

    test('promotes next player when host leaves', () => {
      rm.joinRoom(roomCode, 'Alice', ws1);
      rm.joinRoom(roomCode, 'Bob', ws2);

      rm.removePlayer('player_1');

      const room = rm.getRoom(roomCode);
      const hostPlayer = Array.from(room.players.values()).find((p) => p.isHost);
      expect(hostPlayer).toBeDefined();
      expect(hostPlayer.name).toBe('Bob');
    });
  });

  describe('validateHost', () => {
    let roomCode;

    beforeEach(() => {
      const godotWs = mockWs();
      const result = rm.createRoom(godotWs);
      roomCode = result.roomCode;
    });

    test('returns true for the host player', () => {
      const ws = mockWs();
      rm.joinRoom(roomCode, 'Alice', ws);
      expect(rm.validateHost(roomCode, 'player_1')).toBe(true);
    });

    test('returns false for non-host player', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      rm.joinRoom(roomCode, 'Alice', ws1);
      rm.joinRoom(roomCode, 'Bob', ws2);
      expect(rm.validateHost(roomCode, 'player_2')).toBe(false);
    });

    test('returns false for unknown room', () => {
      expect(rm.validateHost('ZZZZ', 'player_1')).toBe(false);
    });
  });

  describe('buildSnapshot', () => {
    test('returns player distances and timestamp', () => {
      const godotWs = mockWs();
      const result = rm.createRoom(godotWs);
      const roomCode = result.roomCode;
      const ws1 = mockWs();
      rm.joinRoom(roomCode, 'Alice', ws1);

      const snapshot = rm.buildSnapshot(rm.getRoom(roomCode));
      expect(snapshot.type).toBe('room_snapshot');
      expect(snapshot.playerDistances).toBeDefined();
      expect(snapshot.server_snapshot_timestamp).toBeDefined();
    });
  });
});