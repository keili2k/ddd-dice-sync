// sync-client.js - Frontend Synchronisation für DDD Würfelpaare
class DDDSyncClient {
  constructor(serverUrl = 'ws://localhost:3001') {
    this.serverUrl = serverUrl;
    this.socket = null;
    this.isConnected = false;
    this.currentRoomId = null;
    this.participantCount = 0;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;
    
    // Callbacks
    this.onStatusChange = null;
    this.onRoomUpdate = null;
    this.onDiceReceived = null;
    this.onTimerSync = null;
    this.onError = null;
    
    this.init();
  }

  init() {
    // Socket.io laden falls nicht vorhanden
    if (typeof io === 'undefined') {
      this.loadSocketIO().then(() => {
        this.connect();
      });
    } else {
      this.connect();
    }
  }

  loadSocketIO() {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.7.4/socket.io.js';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  connect() {
    try {
      this.socket = io(this.serverUrl, {
        transports: ['websocket', 'polling'],
        timeout: 10000,
        forceNew: true
      });

      this.setupEventListeners();
    } catch (error) {
      console.error('Connection failed:', error);
      this.handleError('Connection failed');
    }
  }

  setupEventListeners() {
    // Verbindung hergestellt
    this.socket.on('connect', () => {
      console.log('Connected to sync server');
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.updateStatus('online', 'Bereit für Synchronisation');
    });

    // Verbindung getrennt
    this.socket.on('disconnect', (reason) => {
      console.log('Disconnected:', reason);
      this.isConnected = false;
      this.updateStatus('offline', 'Verbindung unterbrochen');
      
      if (reason === 'io server disconnect') {
        // Server hat Verbindung getrennt, nicht automatisch reconnecten
        return;
      }
      
      this.attemptReconnect();
    });

    // Verbindungsfehler
    this.socket.on('connect_error', (error) => {
      console.error('Connection error:', error);
      this.updateStatus('offline', 'Verbindungsfehler');
      this.attemptReconnect();
    });

    // Teilnehmer beigetreten
    this.socket.on('participant-joined', (data) => {
      this.participantCount = data.participantCount;
      this.updateRoomInfo();
      this.showNotification(`👋 Neuer Teilnehmer beigetreten! (${data.participantCount} Teilnehmer)`);
    });

    // Teilnehmer verlassen
    this.socket.on('participant-left', (data) => {
      this.participantCount = data.participantCount;
      this.updateRoomInfo();
      this.showNotification(`👋 Teilnehmer hat den Raum verlassen (${data.participantCount} Teilnehmer)`);
    });

    // Würfelergebnis erhalten
    this.socket.on('dice-roll-received', (data) => {
      console.log('Received synced dice roll:', data);
      if (this.onDiceReceived) {
        this.onDiceReceived(data.values);
      }
      this.showNotification('🎲 Synchronisierter Wurf erhalten!');
    });

    // Timer synchronisiert
    this.socket.on('timer-sync-received', (timerState) => {
      console.log('Received timer sync:', timerState);
      if (this.onTimerSync) {
        this.onTimerSync(timerState);
      }
    });

    // Ping-Pong für Verbindungstest
    this.socket.on('pong', (data) => {
      const latency = Date.now() - this.pingTimestamp;
      console.log(`Ping: ${latency}ms`);
    });
  }

  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.updateStatus('offline', 'Reconnect fehlgeschlagen');
      return;
    }

    this.reconnectAttempts++;
    this.updateStatus('connecting', `Reconnect... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    
    setTimeout(() => {
      this.connect();
    }, this.reconnectDelay * this.reconnectAttempts);
  }

  // Öffentliche API
  createRoom() {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        reject(new Error('Not connected to server'));
        return;
      }

      this.socket.emit('create-room', (response) => {
        if (response.success) {
          this.currentRoomId = response.roomId;
          this.participantCount = response.participantCount;
          this.updateStatus('online', `Raum ${response.roomId} erstellt`);
          resolve(response);
        } else {
          reject(new Error(response.error));
        }
      });
    });
  }

  joinRoom(roomId) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        reject(new Error('Not connected to server'));
        return;
      }

      this.socket.emit('join-room', roomId.toUpperCase(), (response) => {
        if (response.success) {
          this.currentRoomId = response.roomId;
          this.participantCount = response.participantCount;
          this.updateStatus('online', `Raum ${response.roomId} beigetreten`);
          
          // Synchronisiere aktuellen Zustand
          if (response.currentDiceValues && this.onDiceReceived) {
            this.onDiceReceived(response.currentDiceValues);
          }
          if (response.timerState && this.onTimerSync) {
            this.onTimerSync(response.timerState);
          }
          
          resolve(response);
        } else {
          reject(new Error(response.error));
        }
      });
    });
  }

  leaveRoom() {
    if (this.isConnected && this.currentRoomId) {
      this.socket.emit('leave-room');
      this.currentRoomId = null;
      this.participantCount = 0;
      this.updateStatus('online', 'Bereit für Synchronisation');
    }
  }

  syncDiceRoll(values) {
    if (this.isConnected && this.currentRoomId) {
      this.socket.emit('sync-dice-roll', values);
    }
  }

  syncTimer(timerState) {
    if (this.isConnected && this.currentRoomId) {
      this.socket.emit('sync-timer', timerState);
    }
  }

  ping() {
    if (this.isConnected) {
      this.pingTimestamp = Date.now();
      this.socket.emit('ping', (response) => {
        console.log('Ping response:', response);
      });
    }
  }

  // Hilfsmethoden
  updateStatus(status, text) {
    if (this.onStatusChange) {
      this.onStatusChange(status, text);
    }
  }

  updateRoomInfo() {
    if (this.onRoomUpdate) {
      this.onRoomUpdate({
        roomId: this.currentRoomId,
        participantCount: this.participantCount
      });
    }
  }

  showNotification(message) {
    // Erstelle Benachrichtigung
    const notification = document.createElement('div');
    notification.className = 'sync-notification';
    notification.textContent = message;
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #28a745;
      color: white;
      padding: 15px 20px;
      border-radius: 10px;
      font-weight: bold;
      z-index: 10001;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      animation: slideInRight 0.3s ease;
      max-width: 300px;
    `;

    document.body.appendChild(notification);

    // Auto-remove nach 3 Sekunden
    setTimeout(() => {
      notification.style.animation = 'slideOutRight 0.3s ease';
      setTimeout(() => {
        if (notification.parentNode) {
          notification.parentNode.removeChild(notification);
        }
      }, 300);
    }, 3000);

    // CSS Animations hinzufügen falls nicht vorhanden
    this.addNotificationStyles();
  }

  addNotificationStyles() {
    if (document.getElementById('sync-notification-styles')) return;

    const style = document.createElement('style');
    style.id = 'sync-notification-styles';
    style.textContent = `
      @keyframes slideInRight {
        from {
          transform: translateX(100%);
          opacity: 0;
        }
        to {
          transform: translateX(0);
          opacity: 1;
        }
      }
      @keyframes slideOutRight {
        from {
          transform: translateX(0);
          opacity: 1;
        }
        to {
          transform: translateX(100%);
          opacity: 0;
        }
      }
    `;
    document.head.appendChild(style);
  }

  handleError(message) {
    console.error('Sync error:', message);
    if (this.onError) {
      this.onError(message);
    }
  }

  // Cleanup
  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.isConnected = false;
    this.currentRoomId = null;
    this.participantCount = 0;
  }
}

// QR Code Utilities
class QRCodeGenerator {
  static generate(text, container, size = 200) {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}&bgcolor=ffffff&color=000000&qzone=2`;
    
    container.innerHTML = `
      <img src="${qrUrl}" 
           alt="QR Code" 
           style="max-width: 100%; height: auto; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);"
           onerror="this.parentNode.innerHTML='<div style=\\'text-align: center; padding: 20px; color: #666;\\'>QR-Code konnte nicht geladen werden</div>'">
    `;
  }

  static generateJoinURL(roomId, baseUrl = window.location.origin + window.location.pathname) {
    return `${baseUrl}?room=${roomId}`;
  }
}

// URL Parameter Helper
class URLHelper {
  static getParameter(name) {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get(name);
  }

  static getRoomFromURL() {
    return this.getParameter('room');
  }

  static removeRoomFromURL() {
    const url = new URL(window.location);
    url.searchParams.delete('room');
    window.history.replaceState({}, '', url);
  }
}

// Clipboard Helper
class ClipboardHelper {
  static async copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      // Fallback für ältere Browser
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      
      try {
        document.execCommand('copy');
        return true;
      } catch (fallbackErr) {
        return false;
      } finally {
        document.body.removeChild(textArea);
      }
    }
  }
}

// Export für Modul-Systeme
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DDDSyncClient, QRCodeGenerator, URLHelper, ClipboardHelper };
}
