const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// rooms: roomId -> { sockets: Set<ws>, title: string, tags: string[] }
const rooms = {};

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

const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
  console.log('New WebSocket connection');

  ws.currentRoomId = null;
  ws.id = Math.random().toString(36).substring(2, 10);
  ws.role = 'listener';
  ws.handRaised = false;
  ws.canSpeak = false;
  ws.displayName = 'Anonymous';

  ws.on('message', raw => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      console.error('Invalid JSON:', raw.toString());
      return;
    }

    // -------- LOBBY: LIST ROOMS --------
    if (data.type === 'list-rooms') {
      const tagFilter = data.tag && String(data.tag).toLowerCase();
      const list = Object.entries(rooms)
        .map(([roomId, room]) => ({
          roomId,
          title: room.title || roomId,
          tags: room.tags || [],
          participantCount: room.sockets.size
        }))
        .filter(r => {
          if (!tagFilter) return true;
          return r.tags.some(t => t.toLowerCase() === tagFilter);
        });

      ws.send(JSON.stringify({
        type: 'rooms-list',
        rooms: list
      }));
      return;
    }

    // -------- NAME SET / UPDATE --------
    if (data.type === 'set-name') {
      const name = (data.name || '').trim().slice(0, 40);
      ws.displayName = name || 'Anonymous';

      const roomId = ws.currentRoomId;
      if (roomId && rooms[roomId]) {
        rooms[roomId].sockets.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'name-updated',
              userId: ws.id,
              name: ws.displayName
            }));
          }
        });
      }
      return;
    }

    // -------- ROOM MANAGEMENT --------
    if (data.type === 'create-room') {
      const roomId = data.roomId;
      const title = data.title || roomId;
      const tags = Array.isArray(data.tags) ? data.tags : [];

      if (!rooms[roomId]) {
        rooms[roomId] = { sockets: new Set(), title, tags };
      }
      rooms[roomId].sockets.add(ws);

      ws.currentRoomId = roomId;
      ws.role = 'host';
      ws.handRaised = false;
      ws.canSpeak = true;

      ws.send(JSON.stringify({
        type: 'create-room',
        roomId,
        title,
        tags
      }));
      return;
    }

    if (data.type === 'join-room') {
      const roomId = data.roomId;
      if (!rooms[roomId]) {
        rooms[roomId] = { sockets: new Set(), title: roomId, tags: [] };
      }

      const room = rooms[roomId];

      // existing peers (ids + names) BEFORE adding this ws
      const existingPeers = Array.from(room.sockets).map(s => ({
        id: s.id,
        name: s.displayName || 'Anonymous'
      }));

      room.sockets.add(ws);
      ws.currentRoomId = roomId;
      ws.role = 'listener';
      ws.handRaised = false;
      ws.canSpeak = false;

      ws.send(JSON.stringify({
        type: 'join-room',
        roomId
      }));

      // give newcomer the peer list
      ws.send(JSON.stringify({
        type: 'room-peers',
        peers: existingPeers
      }));

      // notify existing peers of the newcomer
      room.sockets.forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'peer-joined',
            userId: ws.id,
            name: ws.displayName
          }));
        }
      });

      return;
    }

    if (data.type === 'leave-room') {
      const roomId = data.roomId || ws.currentRoomId;
      if (roomId && rooms[roomId]) {
        rooms[roomId].sockets.delete(ws);
        if (rooms[roomId].sockets.size === 0) {
          delete rooms[roomId];
        } else {
          broadcastToRoom(roomId, {
            type: 'leave-room',
            roomId
          });
        }
      }
      ws.currentRoomId = null;
      ws.role = 'listener';
      ws.handRaised = false;
      ws.canSpeak = false;
      return;
    }

    // -------- HAND RAISING & SPEAK PERMISSION --------
    if (data.type === 'raise-hand') {
      const roomId = ws.currentRoomId;
      if (!roomId || !rooms[roomId]) return;

      ws.handRaised = !!data.raised;

      rooms[roomId].sockets.forEach(client => {
        if (client.role === 'host' && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'hand-updated',
            userId: ws.id,
            raised: ws.handRaised
          }));
        }
      });
      return;
    }

    if (data.type === 'allow-speak') {
      const roomId = ws.currentRoomId;
      if (!roomId || !rooms[roomId]) return;
      if (ws.role !== 'host') return;

      const { userId, allowed } = data;
      rooms[roomId].sockets.forEach(client => {
        if (client.id === userId && client.readyState === WebSocket.OPEN) {
          client.canSpeak = !!allowed;

          client.send(JSON.stringify({
            type: 'speak-permission',
            allowed: !!allowed
          }));

          ws.send(JSON.stringify({
            type: 'speak-permission-updated',
            userId,
            allowed: !!allowed
          }));
        }
      });
      return;
    }

    // -------- HOST: REMOTE AUDIO / VIDEO CONTROL --------
    if (data.type === 'host-mute-audio' || data.type === 'host-hide-video') {
      const roomId = ws.currentRoomId;
      if (!roomId || !rooms[roomId]) return;
      if (ws.role !== 'host') return;

      const { userId, allowed } = data;

      rooms[roomId].sockets.forEach(client => {
        if (client.id === userId && client.readyState === WebSocket.OPEN) {
          if (data.type === 'host-mute-audio') {
            client.send(JSON.stringify({
              type: 'remote-audio-control',
              allowed: !!allowed
            }));
            ws.send(JSON.stringify({
              type: 'speak-permission-updated',
              userId,
              allowed: !!allowed
            }));
          } else {
            client.send(JSON.stringify({
              type: 'remote-video-control',
              allowed: !!allowed
            }));
          }
        }
      });
      return;
    }

    // -------- CHAT --------
    if (data.type === 'chat-message') {
      const roomId = ws.currentRoomId;
      if (!roomId || !rooms[roomId]) return;

      broadcastToRoom(roomId, {
        type: 'chat-message',
        text: data.text,
        name: data.name || ws.displayName || 'Anonymous'
      });
      return;
    }

    // -------- WEBRTC SIGNALING (MESH) --------
    if (data.type === 'offer' || data.type === 'answer' || data.type === 'ice-candidate') {
      const roomId = ws.currentRoomId;
      if (!roomId || !rooms[roomId]) return;

      const targetId = data.to || null;

      rooms[roomId].sockets.forEach(client => {
        if (client === ws || client.readyState !== WebSocket.OPEN) return;
        if (targetId && client.id !== targetId) return;

        client.send(JSON.stringify({
          type: data.type,
          from: ws.id,
          payload: data.payload
        }));
      });
      return;
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
    const roomId = ws.currentRoomId;
    if (roomId && rooms[roomId]) {
      rooms[roomId].sockets.delete(ws);
      if (rooms[roomId].sockets.size === 0) {
        delete rooms[roomId];
      } else {
        broadcastToRoom(roomId, {
          type: 'leave-room',
          roomId
        });
      }
    }
  });
});

function broadcastToRoom(roomId, obj) {
  const room = rooms[roomId];
  if (!room) return;
  const json = JSON.stringify(obj);
  room.sockets.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
