// sync-server.js - WebSocket Backend für DDD Würfelpaare Synchronisation
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3001;

// Raum-Management
const rooms = new Map();

class Room {
  constructor(id) {
    this.id = id;
    this.participants = new Set();
    this.currentDiceValues = null;
    this.timerState = {
      isRunning: false,
      remainingTime: 0,
      duration: 60,
      startTime: null
    };
    this.createdAt = new Date();
  }

  addParticipant(socketId, participantInfo) {
    this.participants.add({
      socketId,
      ...participantInfo,
      joinedAt: new Date()
    });
  }

  removeParticipant(socketId) {
    this.participants = new Set([...this.participants].filter(p => p.socketId !== socketId));
  }

  getParticipantCount() {
    return this.participants.size;
  }

  isEmpty() {
    return this.participants.size === 0;
  }

  broadcast(io, event, data, excludeSocketId = null) {
    this.participants.forEach(participant => {
      if (participant.socketId !== excludeSocketId) {
        io.to(participant.socketId).emit(event, data);
      }
    });
  }
}

// Hilfsfunktionen
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function cleanupEmptyRooms() {
  for (const [roomId, room] of rooms) {
    if (room.isEmpty() || (new Date() - room.createdAt) > 24 * 60 * 60 * 1000) { // 24h cleanup
      rooms.delete(roomId);
      console.log(`Cleaned up room: ${roomId}`);
    }
  }
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Für statische Dateien

// REST API Endpoints
app.get('/api/rooms/:roomId/info', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  res.json({
    id: room.id,
    participantCount: room.getParticipantCount(),
    timerState: room.timerState,
    createdAt: room.createdAt
  });
});

app.post('/api/rooms', (req, res) => {
  let roomId;
  do {
    roomId = generateRoomId();
  } while (rooms.has(roomId));
  
  const room = new Room(roomId);
  rooms.set(roomId, room);
  
  res.json({
    roomId,
    joinUrl: `${req.protocol}://${req.get('host')}?room=${roomId}`
  });
});

// WebSocket Verbindungshandling
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  
  let currentRoom = null;
  let participantInfo = {
    id: socket.id,
    userAgent: socket.handshake.headers['user-agent'] || 'Unknown',
    ip: socket.handshake.address
  };

  // Raum erstellen
  socket.on('create-room', (callback) => {
    let roomId;
    do {
      roomId = generateRoomId();
    } while (rooms.has(roomId));
    
    const room = new Room(roomId);
    room.addParticipant(socket.id, participantInfo);
    rooms.set(roomId, room);
    currentRoom = room;
    
    console.log(`Room created: ${roomId} by ${socket.id}`);
    
    callback({
      success: true,
      roomId,
      participantCount: room.getParticipantCount()
    });
  });

  // Raum beitreten
  socket.on('join-room', (roomId, callback) => {
    const room = rooms.get(roomId);
    if (!room) {
      return callback({
        success: false,
        error: 'Room not found'
      });
    }
    
    // Verlasse aktuellen Raum falls vorhanden
    if (currentRoom) {
      currentRoom.removeParticipant(socket.id);
      currentRoom.broadcast(io, 'participant-left', {
        participantCount: currentRoom.getParticipantCount()
      }, socket.id);
    }
    
    room.addParticipant(socket.id, participantInfo);
    currentRoom = room;
    
    console.log(`${socket.id} joined room: ${roomId}`);
    
    // Benachrichtige andere Teilnehmer
    room.broadcast(io, 'participant-joined', {
      participantCount: room.getParticipantCount()
    }, socket.id);
    
    callback({
      success: true,
      roomId,
      participantCount: room.getParticipantCount(),
      currentDiceValues: room.currentDiceValues,
      timerState: room.timerState
    });
  });

  // Raum verlassen
  socket.on('leave-room', () => {
    if (currentRoom) {
      currentRoom.removeParticipant(socket.id);
      currentRoom.broadcast(io, 'participant-left', {
        participantCount: currentRoom.getParticipantCount()
      }, socket.id);
      
      console.log(`${socket.id} left room: ${currentRoom.id}`);
      currentRoom = null;
    }
  });

  // Würfelergebnis synchronisieren
  socket.on('sync-dice-roll', (diceValues) => {
    if (!currentRoom) return;
    
    console.log(`Dice roll from ${socket.id} in room ${currentRoom.id}:`, diceValues);
    
    currentRoom.currentDiceValues = diceValues;
    currentRoom.broadcast(io, 'dice-roll-received', {
      values: diceValues,
      fromParticipant: socket.id,
      timestamp: new Date()
    }, socket.id);
  });

  // Timer synchronisieren
  socket.on('sync-timer', (timerData) => {
    if (!currentRoom) return;
    
    console.log(`Timer sync from ${socket.id}:`, timerData);
    
    currentRoom.timerState = {
      ...timerData,
      lastUpdatedBy: socket.id,
      lastUpdatedAt: new Date()
    };
    
    currentRoom.broadcast(io, 'timer-sync-received', currentRoom.timerState, socket.id);
  });

  // Chat-Nachrichten (optional)
  socket.on('send-message', (message) => {
    if (!currentRoom) return;
    
    currentRoom.broadcast(io, 'message-received', {
      message,
      fromParticipant: socket.id,
      timestamp: new Date()
    }, socket.id);
  });

  // Ping für Verbindungstest
  socket.on('ping', (callback) => {
    callback({ pong: true, timestamp: new Date() });
  });

  // Verbindung getrennt
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    
    if (currentRoom) {
      currentRoom.removeParticipant(socket.id);
      currentRoom.broadcast(io, 'participant-left', {
        participantCount: currentRoom.getParticipantCount()
      });
      
      // Raum aufräumen wenn leer
      if (currentRoom.isEmpty()) {
        rooms.delete(currentRoom.id);
        console.log(`Room ${currentRoom.id} cleaned up (empty)`);
      }
    }
  });
});

// Regelmäßige Aufräumarbeiten
setInterval(cleanupEmptyRooms, 60 * 60 * 1000); // Jede Stunde

// Server Error Handling
server.on('error', (error) => {
  console.error('Server error:', error);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
  });
});

// Server starten
server.listen(PORT, () => {
  console.log(`🎲 DDD Sync Server running on port ${PORT}`);
  console.log(`📊 Stats: ${rooms.size} active rooms`);
});

module.exports = { app, server, io };
