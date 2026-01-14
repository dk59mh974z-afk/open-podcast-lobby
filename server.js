// ======================
// IMPORTS AND SETUP
// ======================
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

console.log('Starting server...');

// { roomId: Set<WebSocket> }
const rooms = {};

// ======================
// HTTP SERVER (SERVE index.html)
// ======================
const server = http.createServer((req, res) => {
  const filePath = path.join(__dirname, 'index.html');

  fs.readFile(filePath, (err, content) => {
    if (err) {
      console.error('Error reading index.html:', err);
      res.writeHead(500);
      res.end('Error loading page');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(content);
  });
});

// ======================
// WEBSOCKET SERVER
// ======================
const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
  console.log('New WebSocket connection');
  ws.currentRoomId = null;
  ws.id = Math.random().toString(36).substring(2, 10); // simple id

  // ======================
  // HANDLE INCOMING MESSAGES
  // ======================
  ws.on('message', msg => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (e) {
      console.error('Invalid JSON:', msg.toString());
      return;
    }

    // ======================
    // ROOM MANAGEMENT
    // ======================
    if (data.type === 'create-room') {
      const roomId = data.roomId;
      if (!rooms[roomId]) {
        rooms[roomId] = new Set();
      }
      rooms[roomId].add(ws);
      ws.currentRoomId = roomId;

      broadcastToRoom(roomId, {
        type: 'create-room',
        roomId: roomId
      });

    } else if (data.type === 'join-room') {
      const roomId = data.roomId;
      if (!rooms[roomId]) {
        rooms[roomId] = new Set();
      }
      rooms[roomId].add(ws);
      ws.currentRoomId = roomId;

      broadcastToRoom(roomId, {
        type: 'join-room',
        roomId: roomId
      });

    } else if (data.type === 'leave-room') {
      const roomId = data.roomId;
      if (roomId && rooms[roomId]) {
        rooms[roomId].delete(ws);
        if (rooms[roomId].size === 0) {
          delete rooms[roomId];
        } else {
          broadcastToRoom(roomId, {
            type: 'leave-room',
            roomId: roomId
          });
        }
      }
      ws.currentRoomId = null;

    // ======================
    // TEXT CHAT (WITH NAME)
// ======================
    } else if (data.type === 'chat-message') {
      const roomId = ws.currentRoomId;
      console.log(
        'chat-message from client',
        ws.id,
        'roomId:',
        roomId,
        'name:',
        data.name,
        'text:',
        data.text
      );
      if (!roomId || !rooms[roomId]) return;

      // Broadcast name + text to everyone in this room (including sender)
      broadcastToRoom(roomId, {
        type: 'chat-message',
        text: data.text,
        name: data.name || 'Anonymous'
      });

    // ======================
    // WEBRTC SIGNALING (OFFER / ANSWER / ICE)
// ======================
    } else if (
      data.type === 'offer' ||
      data.type === 'answer' ||
      data.type === 'ice-candidate'
    ) {
      const roomId = ws.currentRoomId;
      if (!roomId || !rooms[roomId]) return;

      rooms[roomId].forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: data.type,
            from: ws.id,
            payload: data.payload
          }));
        }
      });
    }
  });

  // ======================
  // CLEANUP ON DISCONNECT
  // ======================
  ws.on('close', () => {
    console.log('WebSocket connection closed');
    const roomId = ws.currentRoomId;
    if (roomId && rooms[roomId]) {
      rooms[roomId].delete(ws);
      if (rooms[roomId].size === 0) {
        delete rooms[roomId];
      }
    }
  });
});

// ======================
// HELPER: BROADCAST TO ROOM
// ======================
function broadcastToRoom(roomId, obj) {
  const room = rooms[roomId];
  if (!room) return;
  const json = JSON.stringify(obj);
  room.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  });
}

// ======================
// START SERVER
// ======================
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
