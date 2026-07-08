const { WebSocketServer } = require('ws');
const RoomManager = require('../roomManager');
const MessageRouter = require('../messageRouter');
const PressThrottle = require('../pressThrottle');
const config = require('../config');

let wss = null;
let roomManager = null;
let messageRouter = null;
let throttle = null;

function ensureInitialized() {
  if (roomManager) return;
  roomManager = new RoomManager();
  throttle = new PressThrottle(config.THROTTLE_RATE);
  messageRouter = new MessageRouter(roomManager, throttle);
}

module.exports = async function handler(req, res) {
  if (!req.headers.upgrade || req.headers.upgrade.toLowerCase() !== 'websocket') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WebSocket server is running');
    return;
  }

  ensureInitialized();

  if (!wss) {
    wss = new WebSocketServer({ noServer: true });

    wss.on('connection', (ws) => {
      ws.tag = null;
      ws.roomCode = null;
      ws.playerId = null;

      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'malformed_message', missing: ['valid JSON'] }));
          return;
        }

        if (!ws.tag) {
          if (msg.type === 'create_room' || msg.type === 'godot_reconnect') {
            ws.tag = 'godot';
            ws.roomCode = msg.roomCode || null;
            messageRouter.handleGodotMessage(ws, msg);
          } else if (msg.type === 'join' || msg.type === 'rejoin') {
            ws.tag = 'controller';
            messageRouter.handleControllerMessage(ws, msg);
          } else {
            ws.send(JSON.stringify({ type: 'error', message: 'malformed_message', missing: ['type'] }));
            ws.close();
          }
          return;
        }

        if (ws.tag === 'godot') {
          messageRouter.handleGodotMessage(ws, msg);
        } else {
          messageRouter.handleControllerMessage(ws, msg);
        }
      });

      ws.on('close', () => {
        if (ws.tag === 'controller' && ws.playerId) {
          throttle.reset(ws.playerId);
          roomManager.reservePlayer(ws.playerId);
        } else if (ws.tag === 'godot' && ws.roomCode) {
          const room = roomManager.getRoom(ws.roomCode);
          if (room) {
            room.godotWs = null;
          }
        }
      });

      ws.on('error', () => {});
    });
  }

  wss.handleUpgrade(req, req.socket, Buffer.alloc(0), (ws) => {
    wss.emit('connection', ws, req);
  });
};
