const MessageRouter = require('../messageRouter');
const RoomManager = require('../roomManager');
const PressThrottle = require('../pressThrottle');
const config = require('../config');

function mockWs(initialData = {}) {
  const messages = [];
  const ws = {
    readyState: 1,
    send: (data) => messages.push(JSON.parse(data)),
    messages,
    playerId: initialData.playerId || null,
    roomCode: initialData.roomCode || null,
    tag: initialData.tag || null,
  };
  return ws;
}

describe('MessageRouter', () => {
  let roomManager, throttle, router;

  beforeEach(() => {
    jest.useFakeTimers();
    roomManager = new RoomManager();
    throttle = new PressThrottle(config.THROTTLE_RATE);
    router = new MessageRouter(roomManager, throttle);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('handleGodotMessage - create_room', () => {
    test('creates a room and sends room_created back', () => {
      const ws = mockWs();
      router.handleGodotMessage(ws, { type: 'create_room' });
      const roomCreated = ws.messages.find((m) => m.type === 'room_created');
      expect(roomCreated).toBeDefined();
      expect(roomCreated.roomCode).toBeDefined();
    });
  });

  describe('handleControllerMessage - join', () => {
    let roomCode;

    beforeEach(() => {
      const godotWs = mockWs();
      const result = roomManager.createRoom(godotWs);
      roomCode = result.roomCode;
    });

    test('successfully joins a room', () => {
      const ws = mockWs();
      router.handleControllerMessage(ws, { type: 'join', roomCode, playerName: 'Alice' });
      const joined = ws.messages.find((m) => m.type === 'joined');
      expect(joined).toBeDefined();
      expect(joined.isHost).toBe(true);
    });

    test('sends error for invalid room code', () => {
      const ws = mockWs();
      router.handleControllerMessage(ws, { type: 'join', roomCode: 'ZZZZ', playerName: 'Alice' });
      const error = ws.messages.find((m) => m.type === 'error');
      expect(error).toBeDefined();
      expect(error.message).toBe('invalid_room');
    });

    test('sends malformed_message for missing fields', () => {
      const ws = mockWs();
      router.handleControllerMessage(ws, { type: 'join' });
      const error = ws.messages.find((m) => m.type === 'error');
      expect(error).toBeDefined();
      expect(error.message).toBe('malformed_message');
      expect(error.missing).toContain('roomCode');
    });
  });

  describe('handleControllerMessage - start', () => {
    let roomCode;
    let godotWs;
    let hostWs;

    beforeEach(() => {
      godotWs = mockWs();
      const result = roomManager.createRoom(godotWs);
      roomCode = result.roomCode;

      hostWs = mockWs();
      roomManager.joinRoom(roomCode, 'Alice', hostWs);

      const ws2 = mockWs();
      roomManager.joinRoom(roomCode, 'Bob', ws2);
    });

    test('host can start the race — transitions to COUNTDOWN, then RACING after delay', () => {
      router.handleControllerMessage(hostWs, {
        type: 'start',
        roomCode,
        playerId: 'player_1',
      });

      const room = roomManager.getRoom(roomCode);
      expect(room.state).toBe('COUNTDOWN');

      jest.advanceTimersByTime(config.COUNTDOWN_SECONDS * 1000);

      expect(room.state).toBe('RACING');
    });

    test('non-host cannot start the race', () => {
      const ws2 = mockWs();
      roomManager.joinRoom(roomCode, 'Charlie', ws2);

      const nonHostWs = mockWs();
      roomManager.joinRoom(roomCode, 'Dave', nonHostWs);

      nonHostWs.playerId = 'player_4';
      roomManager.getRoom(roomCode).players.get('player_4').isHost = false;

      router.handleControllerMessage(nonHostWs, {
        type: 'start',
        roomCode,
        playerId: 'player_4',
      });

      const error = nonHostWs.messages.find((m) => m.type === 'error');
      expect(error).toBeDefined();
      expect(error.message).toBe('not_host');
    });

    test('sends malformed_message for missing playerId', () => {
      const ws = mockWs();
      router.handleControllerMessage(ws, { type: 'start', roomCode });
      const error = ws.messages.find((m) => m.type === 'error');
      expect(error).toBeDefined();
      expect(error.message).toBe('malformed_message');
    });
  });

  describe('handleControllerMessage - press', () => {
    let roomCode;

    beforeEach(() => {
      const godotWs = mockWs();
      const result = roomManager.createRoom(godotWs);
      roomCode = result.roomCode;

      const ws1 = mockWs();
      const ws2 = mockWs();
      roomManager.joinRoom(roomCode, 'Alice', ws1);
      roomManager.joinRoom(roomCode, 'Bob', ws2);
      roomManager.transitionState(roomCode, 'COUNTDOWN');
      roomManager.transitionState(roomCode, 'RACING');
    });

    test('sends press_ack accepted for valid press', () => {
      const controllerWs = mockWs();
      controllerWs.playerId = 'player_1';
      const room = roomManager.getRoom(roomCode);
      room.players.get('player_1').ws = controllerWs;

      router.handleControllerMessage(controllerWs, {
        type: 'press',
        roomCode,
        playerId: 'player_1',
      });

      const ack = controllerWs.messages.find((m) => m.type === 'press_ack');
      expect(ack).toBeDefined();
      expect(ack.accepted).toBe(true);
    });
  });

  describe('handleGodotMessage - start', () => {
    test('Godot client can start — transitions to COUNTDOWN then RACING after delay', () => {
      const godotWs = mockWs();
      const result = roomManager.createRoom(godotWs);
      const roomCode = result.roomCode;

      const ws1 = mockWs();
      const ws2 = mockWs();
      roomManager.joinRoom(roomCode, 'Alice', ws1);
      roomManager.joinRoom(roomCode, 'Bob', ws2);

      router.handleGodotMessage(godotWs, { type: 'start', roomCode });
      const room = roomManager.getRoom(roomCode);
      expect(room.state).toBe('COUNTDOWN');

      jest.advanceTimersByTime(config.COUNTDOWN_SECONDS * 1000);
      expect(room.state).toBe('RACING');
    });
  });

  describe('handleGodotMessage - godot_reconnect', () => {
    test('reconnects Godot client to existing room', () => {
      const oldGodotWs = mockWs();
      const result = roomManager.createRoom(oldGodotWs);
      const roomCode = result.roomCode;

      const ws1 = mockWs();
      roomManager.joinRoom(roomCode, 'Alice', ws1);

      const newGodotWs = mockWs();
      router.handleGodotMessage(newGodotWs, { type: 'godot_reconnect', roomCode });

      expect(newGodotWs.tag).toBe('godot');
      const snapshot = newGodotWs.messages.find((m) => m.type === 'room_snapshot');
      expect(snapshot).toBeDefined();
    });

    test('sends error for invalid room code', () => {
      const ws = mockWs();
      router.handleGodotMessage(ws, { type: 'godot_reconnect', roomCode: 'ZZZZ' });
      const error = ws.messages.find((m) => m.type === 'error');
      expect(error).toBeDefined();
      expect(error.message).toBe('invalid_room');
    });
  });

  describe('handleGodotMessage - race_results', () => {
    test('broadcasts results and transitions to FINISHED', () => {
      const godotWs = mockWs();
      const result = roomManager.createRoom(godotWs);
      const roomCode = result.roomCode;

      const ws1 = mockWs();
      const ws2 = mockWs();
      roomManager.joinRoom(roomCode, 'Alice', ws1);
      roomManager.joinRoom(roomCode, 'Bob', ws2);
      roomManager.transitionState(roomCode, 'COUNTDOWN');
      roomManager.transitionState(roomCode, 'RACING');

      router.handleGodotMessage(godotWs, {
        type: 'race_results',
        roomCode,
        rankings: [{ playerId: 'player_1', name: 'Alice', distance: 1000 }],
      });

      const room = roomManager.getRoom(roomCode);
      expect(room.state).toBe('FINISHED');
    });
  });
});