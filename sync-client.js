// sync-client-netlify.js - Netlify Functions Sync Client (ohne WebSocket)
class DDDSyncClient {
  constructor(serverUrl = null) {
    // Automatische Server-URL Erkennung für Netlify Functions
    if (!serverUrl) {
      if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        // Lokale Entwicklung mit Netlify Dev
        this.serverUrl = 'http://localhost:8888/.netlify/functions/sync';
      } else {
        // Production auf Netlify
        this.serverUrl = `${window.location.origin}/.netlify/functions/sync`;
      }
    } else {
      this.serverUrl = serverUrl;
    }
    
    this.isConnected = false;
    this.currentRoomId = null;
    this.sessionId = null;
    this.participantCount = 0;
    this.pollInterval = null;
    this.pollDelay = 2000; // 2 Sekunden
    this.lastPollTimestamp = null;
    
    // Callbacks
    this.onStatusChange = null;
    this.onRoomUpdate = null;
    this.onDiceReceived = null;
    this.onTimerSync = null;
    this.onError = null;
    
    console.log('DDD Netlify Sync Client initialized with URL:', this.serverUrl);
    this.testConnection();
  }

  async testConnection() {
    this.updateStatus('connecting', 'Teste Serververbindung...');
    
    try {
      const response = await fetch(this.serverUrl + '/health');
      if (response.ok) {
        const data = await response.json();
        console.log('Server health check successful:', data);
        this.isConnected = true;
        this.updateStatus('online', 'Bereit für Synchronisation');
      } else {
        throw new Error(`Server responded with ${response.status}`);
      }
    } catch (error) {
      console.error('Server connection test failed:', error);
      this.isConnected = false;
      this.updateStatus('offline', 'Server nicht erreichbar');
      this.handleError('Server nicht verfügbar: ' + error.message);
    }
  }

  async makeRequest(endpoint, data = null, method = 'GET') {
    try {
      const options = {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
      };

      if (data && method !== 'GET') {
        options.body = JSON.stringify(data);
      }

      const response = await fetch(this.serverUrl + endpoint, options);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`Request to ${endpoint} failed:`, error);
      throw error;
    }
  }

  startPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }

    this.pollInterval = setInterval(async () => {
      if (!this.currentRoomId || !this.sessionId) return;

      try {
        const response = await this.makeRequest('/poll', {
          roomId: this.currentRoomId,
          sessionId: this.sessionId,
          since: this.lastPollTimestamp
        }, 'POST');

        if (response.success) {
          // Aktualisiere Teilnehmerzahl
          if (response.participantCount !== this.participantCount) {
            this.participantCount = response.participantCount;
            this.updateRoomInfo();
          }

          // Verarbeite neue Nachrichten
          response.messages.forEach(message => {
            this.handleMessage(message);
          });

          this.lastPollTimestamp = response.timestamp;
        }
      } catch (error) {
        console.error('Polling error:', error);
        // Bei Fehlern weniger häufig pollen
        this.pollDelay = Math.min(this.pollDelay * 1.5, 10000); // Max 10 Sekunden
      }
    }, this.pollDelay);
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  handleMessage(message) {
    console.log('Received message:', message);

    switch (message.type) {
      case 'dice-roll':
        if (this.onDiceReceived) {
          this.onDiceReceived(message.values);
        }
        this.showNotification('🎲 Synchronisierter Wurf erhalten!');
        break;

      case 'timer-sync':
        if (this.onTimerSync) {
          this.onTimerSync(message.timerState);
        }
        break;

      default:
        console.log('Unknown message type:', message.type);
    }
  }

  // Öffentliche API
  async createRoom() {
    if (!this.isConnected) {
      throw new Error('Nicht mit Server verbunden');
    }

    try {
      const response = await this.makeRequest('/create-room', {}, 'POST');
      
      if (response.success) {
        this.currentRoomId = response.roomId;
        this.sessionId = response.sessionId;
        this.participantCount = response.participantCount;
        this.updateStatus('online', `Raum ${response.roomId} erstellt`);
        this.startPolling();
        return response;
      } else {
        throw new Error(response.error);
      }
    } catch (error) {
      this.handleError('Raum erstellen fehlgeschlagen: ' + error.message);
      throw error;
    }
  }

  async joinRoom(roomId) {
    if (!this.isConnected) {
      throw new Error('Nicht mit Server verbunden');
    }

    try {
      const response = await this.makeRequest('/join-room', {
        roomId: roomId.toUpperCase()
      }, 'POST');
      
      if (response.success) {
        this.currentRoomId = response.roomId;
        this.sessionId = response.sessionId;
        this.participantCount = response.participantCount;
        this.updateStatus('online', `Raum ${response.roomId} beigetreten`);
        
        // Synchronisiere aktuellen Zustand
        if (response.currentDiceValues && this.onDiceReceived) {
          setTimeout(() => {
            this.onDiceReceived(response.currentDiceValues);
          }, 100);
        }
        if (response.timerState && this.onTimerSync) {
          setTimeout(() => {
            this.onTimerSync(response.timerState);
          }, 100);
        }
        
        this.startPolling();
        return response;
      } else {
        throw new Error(response.error);
      }
    } catch (error) {
      this.handleError('Raum beitreten fehlgeschlagen: ' + error.message);
      throw error;
    }
  }

  async leaveRoom() {
    if (this.currentRoomId && this.sessionId) {
      try {
        await this.makeRequest('/leave-room', {
          roomId: this.currentRoomId,
          sessionId: this.sessionId
        }, 'POST');
      } catch (error) {
        console.error('Leave room error:', error);
      }
    }

    this.stopPolling();
    this.currentRoomId = null;
    this.sessionId = null;
    this.participantCount = 0;
    this.lastPollTimestamp = null;
    this.updateStatus('online', 'Bereit für Synchronisation');
  }

  async syncDiceRoll(values) {
    if (!this.isConnected || !this.currentRoomId || !this.sessionId) {
      return;
    }

    try {
      console.log('Syncing dice roll:', values);
      await this.makeRequest('/sync-dice', {
        roomId: this.currentRoomId,
        sessionId: this.sessionId,
        diceValues: values
      }, 'POST');
    } catch (error) {
      console.error('Sync dice roll failed:', error);
    }
  }

  async syncTimer(timerState) {
    if (!this.isConnected || !this.currentRoomId || !this.sessionId) {
      return;
    }

    try {
      console.log('Syncing timer state:', timerState);
      await this.makeRequest('/sync-timer', {
        roomId: this.currentRoomId,
        sessionId: this.sessionId,
        timerState
      }, 'POST');
    } catch (error) {
      console.error('Sync timer failed:', error);
    }
  }

  ping() {
    // Für HTTP-basierte API weniger relevant, aber wir können einen Health Check machen
    return this.testConnection();
  }

  // Hilfsmethoden
  updateStatus(status, text) {
    console.log(`Status: ${status} - ${text}`);
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
    console.log('Notification:', message);
    
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
    this.stopPolling();
    this.isConnected = false;
    this.currentRoomId = null;
    this.sessionId = null;
    this.participantCount = 0;
  }

  // Debug-Informationen
  getDebugInfo() {
    return {
      serverUrl: this.serverUrl,
      isConnected: this.isConnected,
      currentRoomId: this.currentRoomId,
      sessionId: this.sessionId,
      participantCount: this.participantCount,
      pollDelay: this.pollDelay,
      isPolling: !!this.pollInterval
    };
  }
}

// QR Code Utilities (unverändert)
class QRCodeGenerator {
  static generate(text, container, size = 200) {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}&bgcolor=ffffff&color=000000&qzone=2&format=png`;
    
    container.innerHTML = `
      <img src="${qrUrl}" 
           alt="QR Code" 
           style="max-width: 100%; height: auto; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);"
           onerror="this.parentNode.innerHTML='<div style=\\'text-align: center; padding: 20px; color: #666; border: 2px dashed #ddd; border-radius: 8px;\\'>QR-Code konnte nicht geladen werden<br><small>URL: ${text}</small></div>'">
    `;
  }

  static generateJoinURL(roomId, baseUrl = window.location.origin + window.location.pathname) {
    return `${baseUrl}?room=${roomId}`;
  }
}

// URL Parameter Helper (unverändert)
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

// Clipboard Helper (unverändert)
class ClipboardHelper {
  static async copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      console.log('Copied to clipboard:', text);
      return true;
    } catch (err) {
      console.warn('Clipboard API failed, trying fallback:', err);
      // Fallback für ältere Browser
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      textArea.style.top = '-9999px';
      document.body.appendChild(textArea);
      textArea.select();
      
      try {
        const result = document.execCommand('copy');
        console.log('Fallback copy result:', result);
        return result;
      } catch (fallbackErr) {
        console.error('Both clipboard methods failed:', fallbackErr);
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

// Global verfügbar machen für Browser
if (typeof window !== 'undefined') {
  window.DDDSyncClient = DDDSyncClient;
  window.QRCodeGenerator = QRCodeGenerator;
  window.URLHelper = URLHelper;
  window.ClipboardHelper = ClipboardHelper;
                    }
