// netlify/functions/sync.js - Erweitert um Player Management
const rooms = new Map();

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

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
    this.players = new Map(); // sessionId -> player data
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
    this.players.delete(sessionId); // Spielerdaten auch entfernen
    this.lastActivity = new Date();
  }

  updatePlayerData(sessionId, playersArray) {
    // Wichtig: playersArray ist ein Array von Spielern für diese Session
    // Alle Spieler dieser Session ersetzen (nicht nur hinzufügen)
    
    // Lösche alte Spieler dieser Session
    this.players.delete(sessionId);
    
    // Füge neue/aktualisierte Spieler hinzu
    if (playersArray && playersArray.length > 0) {
      // Aktivitätslimit prüfen
      const activePlayersFromOtherSessions = Array.from(this.players.values())
        .flat()
        .filter(p => p.isActive).length;
      
      const updatedPlayers = playersArray.map(playerData => {
        // Überprüfe ob dieser Spieler aktiv sein kann
        const canBeActive = (activePlayersFromOtherSessions < 4) || playerData.isActive;
        
        return {
          ...playerData,
          sessionId: sessionId,
          isActive: canBeActive,
          lastUpdated: new Date()
        };
      });
      
      this.players.set(sessionId, updatedPlayers);
    }
    
    this.lastActivity = new Date();
  }

  getPlayerData() {
    // Alle Spieler aus allen Sessions als flache Liste zurückgeben
    const allPlayers = [];
    for (const playersArray of this.players.values()) {
      allPlayers.push(...playersArray);
    }
    return allPlayers;
  }

  getActivePlayerCount() {
    return this.getPlayerData().filter(p => p.isActive).length;
  }

}

// Im sync-players Endpoint:
if (path === '/sync-players' && method === 'POST') {
  const { roomId, sessionId, players } = body;
  const room = rooms.get(roomId);
  
  if (!room) {
    return {
      statusCode: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: 'Raum nicht gefunden' })
    };
  }

  room.updateParticipant(sessionId);
  
  // WICHTIG: players ist bereits ein Array von Spielern
  // Spielerdaten für diese Session komplett aktualisieren
  room.updatePlayerData(sessionId, players);
  
  // Message für andere Clients
  room.addMessage({
    type: 'players-update',
    players: room.getPlayerData(), // Alle Spieler aller Sessions
    fromSession: sessionId
  });

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success: true,
      participantCount: room.getParticipantCount(),
      activePlayerCount: room.getActivePlayerCount(),
      players: room.getPlayerData()
    })
  };

  getParticipantCount() {
    // Entferne inaktive Teilnehmer (älter als 5 Minuten)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    for (const [sessionId, participant] of this.participants) {
      if (participant.lastSeen < fiveMinutesAgo) {
        this.participants.delete(sessionId);
        this.players.delete(sessionId); // Auch Spielerdaten entfernen
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
    if (!since) return this.messages.slice(-10);
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
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: '',
    };
  }

  if (Math.random() < 0.1) {
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
          activePlayerCount: room.getActivePlayerCount(),
          joinUrl: `${event.headers.origin || 'https://ddd-dice-sync.netlify.app'}?room=${roomId}`
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
          activePlayerCount: room.getActivePlayerCount(),
          currentDiceValues: room.currentDiceValues,
          timerState: room.timerState,
          players: room.getPlayerData()
        })
      };
    }

    // Spieler synchronisieren - NEUE FUNKTION
    if (path === '/sync-players' && method === 'POST') {
      const { roomId, sessionId, players } = body;
      const room = rooms.get(roomId);
      
      if (!room) {
        return {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: false, error: 'Raum nicht gefunden' })
        };
      }

      room.updateParticipant(sessionId);
      
      // Spielerdaten für diese Session aktualisieren
      players.forEach(playerData => {
        // Sicherheitscheck: Nur eigene Spieler dürfen synchronisiert werden
        const playerWithSession = {
          ...playerData,
          sessionId: sessionId,
          isActive: room.getActivePlayerCount() < 4 || 
                   (room.players.has(sessionId) && room.players.get(sessionId).isActive)
        };
        
        room.updatePlayerData(sessionId, playerWithSession);
      });
      
      room.addMessage({
        type: 'players-update',
        players: room.getPlayerData(),
        fromSession: sessionId
      });

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          participantCount: room.getParticipantCount(),
          activePlayerCount: room.getActivePlayerCount(),
          players: room.getPlayerData()
        })
      };
    }

    // Würfel synchronisieren (unverändert)
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

    // Timer synchronisieren (unverändert)
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

    // Nachrichten abrufen (erweitert um Spielerdaten)
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
          activePlayerCount: room.getActivePlayerCount(),
          currentDiceValues: room.currentDiceValues,
          timerState: room.timerState,
          players: room.getPlayerData(), // Spielerdaten mitliefern
          timestamp: new Date().toISOString()
        })
      };
    }

    // Raum verlassen (erweitert)
    if (path === '/leave-room' && method === 'POST') {
      const { roomId, sessionId } = body;
      const room = rooms.get(roomId);
      
      if (room) {
        room.removeParticipant(sessionId);
        
        // Benachrichtigung über entfernte Spieler
        room.addMessage({
          type: 'players-update',
          players: room.getPlayerData(),
          fromSession: sessionId
        });
        
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

    // Raum-Info (erweitert)
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
          activePlayerCount: room.getActivePlayerCount(),
          timerState: room.timerState,
          players: room.getPlayerData(),
          createdAt: room.createdAt,
          lastActivity: room.lastActivity
        })
      };
    }

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
