const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const RoomManager = require('./roomManager');
const MessageRouter = require('./messageRouter');
const PressThrottle = require('./pressThrottle');
const config = require('./config');

const roomManager = new RoomManager();
const throttle = new PressThrottle(config.THROTTLE_RATE);
const messageRouter = new MessageRouter(roomManager, throttle);

const publicDir = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  const fullPath = path.join(publicDir, filePath);

  const ext = path.extname(fullPath);
  const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  };

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

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

server.listen(config.PORT, () => {
  console.log(`Server running on http://localhost:${config.PORT}`);
});

module.exports = { server, wss, roomManager, throttle, messageRouter };