// netlify/functions/sync.js - Serverless WebSocket Alternative
const rooms = new Map();

// CORS Headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// Room Management
class Room {
  constructor(id) {
    this.id = id;
    this.participants = new Map();
    this.currentDiceValues = null;
    this.timerState = {
      isRunning: false,
      remainingTime: 0,
      duration: 60,
      startTime: null
    };
    this.messages = [];
    this.createdAt = new Date();
    this.lastActivity = new Date();
  }

  addParticipant(sessionId, participantInfo) {
    this.participants.set(sessionId, {
      sessionId,
      ...participantInfo,
      joinedAt: new Date(),
      lastSeen: new Date()
    });
    this.lastActivity = new Date();
  }

  removeParticipant(sessionId) {
    this.participants.delete(sessionId);
    this.lastActivity = new Date();
  }

  getParticipantCount() {
    // Entferne inaktive Teilnehmer (älter als 5 Minuten)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    for (const [sessionId, participant] of this.participants) {
      if (participant.lastSeen < fiveMinutesAgo) {
        this.participants.delete(sessionId);
      }
    }
    return this.participants.size;
  }

  updateParticipant(sessionId) {
    const participant = this.participants.get(sessionId);
    if (participant) {
      participant.lastSeen = new Date();
      this.lastActivity = new Date();
    }
  }

  addMessage(message) {
    this.messages.push({
      ...message,
      timestamp: new Date(),
      id: Date.now() + Math.random()
    });
    
    // Behalte nur die letzten 50 Nachrichten
    if (this.messages.length > 50) {
      this.messages = this.messages.slice(-50);
    }
    
    this.lastActivity = new Date();
  }

  getRecentMessages(since = null) {
    if (!since) return this.messages.slice(-10); // Letzte 10 Nachrichten
    const sinceDate = new Date(since);
    return this.messages.filter(msg => new Date(msg.timestamp) > sinceDate);
  }

  isEmpty() {
    return this.getParticipantCount() === 0;
  }

  isExpired() {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    return this.lastActivity < oneHourAgo;
  }
}

// Hilfsfunktionen
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generateSessionId() {
  return 'session_' + Math.random().toString(36).substring(2, 15);
}

function cleanupRooms() {
  for (const [roomId, room] of rooms) {
    if (room.isEmpty() || room.isExpired()) {
      rooms.delete(roomId);
      console.log(`Cleaned up room: ${roomId}`);
    }
  }
}

// Hauptfunktion
exports.handler = async (event, context) => {
  // CORS Preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: '',
    };
  }

  // Cleanup bei jeder Anfrage (einfacher Scheduler)
  if (Math.random() < 0.1) { // 10% Chance
    cleanupRooms();
  }

  const path = event.path.replace('/.netlify/functions/sync', '');
  const method = event.httpMethod;
  const body = event.body ? JSON.parse(event.body) : {};

  console.log(`${method} ${path}`, body);

  try {
    // Health Check
    if (path === '/health' || path === '') {
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'healthy',
          rooms: rooms.size,
          timestamp: new Date().toISOString()
        })
      };
    }

    // Raum erstellen
    if (path === '/create-room' && method === 'POST') {
      let roomId;
      do {
        roomId = generateRoomId();
      } while (rooms.has(roomId));

      const room = new Room(roomId);
      const sessionId = generateSessionId();
      
      room.addParticipant(sessionId, {
        userAgent: event.headers['user-agent'] || 'Unknown',
        ip: event.headers['client-ip'] || 'Unknown'
      });
      
      rooms.set(roomId, room);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          roomId,
          sessionId,
          participantCount: room.getParticipantCount(),
          joinUrl: `${event.headers.origin || 'https://benevolent-maamoul-196578.netlify.app'}?room=${roomId}`
        })
      };
    }

    // Raum beitreten
    if (path === '/join-room' && method === 'POST') {
      const { roomId } = body;
      const room = rooms.get(roomId);
      
      if (!room) {
        return {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: false,
            error: 'Raum nicht gefunden'
          })
        };
      }

      const sessionId = generateSessionId();
      room.addParticipant(sessionId, {
        userAgent: event.headers['user-agent'] || 'Unknown',
        ip: event.headers['client-ip'] || 'Unknown'
      });

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          roomId,
          sessionId,
          participantCount: room.getParticipantCount(),
          currentDiceValues: room.currentDiceValues,
          timerState: room.timerState
        })
      };
    }

    // Würfel synchronisieren
    if (path === '/sync-dice' && method === 'POST') {
      const { roomId, sessionId, diceValues } = body;
      const room = rooms.get(roomId);
      
      if (!room) {
        return {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: false, error: 'Raum nicht gefunden' })
        };
      }

      room.updateParticipant(sessionId);
      room.currentDiceValues = diceValues;
      
      room.addMessage({
        type: 'dice-roll',
        values: diceValues,
        fromSession: sessionId
      });

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          participantCount: room.getParticipantCount()
        })
      };
    }

    // Timer synchronisieren
    if (path === '/sync-timer' && method === 'POST') {
      const { roomId, sessionId, timerState } = body;
      const room = rooms.get(roomId);
      
      if (!room) {
        return {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: false, error: 'Raum nicht gefunden' })
        };
      }

      room.updateParticipant(sessionId);
      room.timerState = {
        ...timerState,
        lastUpdatedBy: sessionId,
        lastUpdatedAt: new Date()
      };

      room.addMessage({
        type: 'timer-sync',
        timerState: room.timerState,
        fromSession: sessionId
      });

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          participantCount: room.getParticipantCount()
        })
      };
    }

    // Nachrichten abrufen (Polling)
    if (path === '/poll' && method === 'POST') {
      const { roomId, sessionId, since } = body;
      const room = rooms.get(roomId);
      
      if (!room) {
        return {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: false, error: 'Raum nicht gefunden' })
        };
      }

      room.updateParticipant(sessionId);
      const messages = room.getRecentMessages(since);
      
      // Filtere eigene Nachrichten heraus
      const filteredMessages = messages.filter(msg => msg.fromSession !== sessionId);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          messages: filteredMessages,
          participantCount: room.getParticipantCount(),
          currentDiceValues: room.currentDiceValues,
          timerState: room.timerState,
          timestamp: new Date().toISOString()
        })
      };
    }

    // Raum verlassen
    if (path === '/leave-room' && method === 'POST') {
      const { roomId, sessionId } = body;
      const room = rooms.get(roomId);
      
      if (room) {
        room.removeParticipant(sessionId);
        
        if (room.isEmpty()) {
          rooms.delete(roomId);
        }
      }

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };
    }

    // Raum-Info
    if (path.startsWith('/room/') && method === 'GET') {
      const roomId = path.replace('/room/', '');
      const room = rooms.get(roomId);
      
      if (!room) {
        return {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Raum nicht gefunden' })
        };
      }

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: room.id,
          participantCount: room.getParticipantCount(),
          timerState: room.timerState,
          createdAt: room.createdAt,
          lastActivity: room.lastActivity
        })
      };
    }

    // 404 für unbekannte Endpunkte
    return {
      statusCode: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Endpunkt nicht gefunden' })
    };

  } catch (error) {
    console.error('Function error:', error);
    
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Interner Serverfehler',
        message: error.message
      })
    };
  }
};
