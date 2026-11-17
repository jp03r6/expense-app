/**
 * ExpenseSnap - Multi-Device Sync & QR Pairing
 *
 * Sync sends receipts between devices through a free PUBLIC relay
 * (broker.hivemq.com, using MQTT over a secure WebSocket). Messages are NOT
 * encrypted end-to-end, so anyone who knows or guesses the room code could
 * read them. Because of that, Sync is OFF by default:
 * - Nothing connects to the relay, and the MQTT library is not even loaded,
 *   until the user turns Sync on in Settings.
 * - The on/off choice is saved in localStorage ('expensesnap_sync_enabled').
 *   Older versions never saved this key, so upgrading always starts with
 *   Sync off. The saved room code is kept so it can be turned back on.
 */

const SYNC_ENABLED_KEY = 'expensesnap_sync_enabled';
const MQTT_SCRIPT_SRC = 'vendor/mqttws31.min.js';

class CloudSyncManager {
  constructor() {
    this.status = 'off'; // 'off', 'connecting', 'online', 'offline'
    this.syncRoomId = null;
    this.enabled = localStorage.getItem(SYNC_ENABLED_KEY) === '1';
    this.mqttLoadPromise = null;
    
    // Persistent device ID per browser so refreshes don't look like new devices
    let savedDevId = localStorage.getItem('expensesnap_device_id');
    if (!savedDevId) {
      savedDevId = 'dev_' + Math.random().toString(36).substr(2, 9);
      localStorage.setItem('expensesnap_device_id', savedDevId);
    }
    this.deviceId = savedDevId;

    this.mqttClient = null;
    this.peerHeartbeats = new Map(); // senderId -> timestamp (with active TTL)
    this.listeners = [];
    this.isConnected = false;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.cleanupTimer = null;
  }

  async init() {
    // 1. Check URL parameters for ?room=XXXXXX pairing code
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('room')) {
      const roomFromUrl = urlParams.get('room').toUpperCase();
      this.syncRoomId = roomFromUrl;
      localStorage.setItem('expensesnap_room_id', roomFromUrl);
    } else {
      const savedRoom = localStorage.getItem('expensesnap_room_id');
      if (savedRoom) {
        this.syncRoomId = savedRoom;
      } else {
        this.syncRoomId = this.generateRoomCode();
        localStorage.setItem('expensesnap_room_id', this.syncRoomId);
      }
    }

    // 2. Connect only if the user has turned Sync on
    if (this.enabled) this._start();

    // 3. Notify peers when closing the window
    window.addEventListener('beforeunload', () => {
      if (this.isConnected) {
        this.publish('presence', { type: 'LEAVE', deviceId: this.deviceId });
      }
    });
  }

  isEnabled() {
    return this.enabled;
  }

  // Turn Sync on or off. The choice is remembered on this device.
  async setEnabled(on) {
    on = !!on;
    if (on === this.enabled) return;
    this.enabled = on;
    localStorage.setItem(SYNC_ENABLED_KEY, on ? '1' : '0');
    if (on) {
      await this._start();
    } else {
      this._stop();
    }
  }

  // Load the MQTT library only when Sync is turned on.
  _loadMqttLibrary() {
    if (window.Paho && window.Paho.MQTT) return Promise.resolve();
    if (!this.mqttLoadPromise) {
      this.mqttLoadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = MQTT_SCRIPT_SRC;
        script.onload = () => resolve();
        script.onerror = () => {
          this.mqttLoadPromise = null;
          reject(new Error('Could not load the sync library'));
        };
        document.head.appendChild(script);
      });
    }
    return this.mqttLoadPromise;
  }

  async _start() {
    this.status = 'connecting';
    this.notifyStatus();
    try {
      await this._loadMqttLibrary();
    } catch (err) {
      console.warn(err.message);
      this.status = 'offline';
      this.notifyStatus();
      return;
    }
    if (!this.enabled) return; // turned off while the library was loading

    this.connect();

    // Periodic heartbeat to tell peers we are alive
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.isConnected) {
        this.publish('presence', { type: 'PING', deviceId: this.deviceId, timestamp: Date.now() });
      }
    }, 8000);

    // Periodic cleanup to remove peers that haven't pinged in 18 seconds
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = setInterval(() => {
      this.cleanStalePeers();
    }, 4000);
  }

  _stop() {
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    clearInterval(this.cleanupTimer);
    this.reconnectTimer = this.heartbeatTimer = this.cleanupTimer = null;
    const client = this.mqttClient;
    this.mqttClient = null;
    if (client) {
      if (this.isConnected) {
        try {
          const msg = new window.Paho.MQTT.Message(JSON.stringify({
            type: 'LEAVE', deviceId: this.deviceId, senderId: this.deviceId, roomId: this.syncRoomId
          }));
          msg.destinationName = `expensesnap/app_v2/${this.syncRoomId}/presence`;
          client.send(msg);
        } catch (e) {}
      }
      client.onConnectionLost = () => {};
      client.onMessageArrived = () => {};
      try { client.disconnect(); } catch (e) {}
    }
    this.isConnected = false;
    this.peerHeartbeats.clear();
    this.status = 'off';
    this.notifyStatus();
  }

  generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return 'EXP-' + code;
  }

  getPairingLink() {
    const base = window.location.origin + window.location.pathname;
    return `${base}?room=${encodeURIComponent(this.syncRoomId)}`;
  }

  setRoomCode(newCode) {
    if (!newCode || newCode.trim().length < 4) {
      throw new Error('Room code must be at least 4 characters.');
    }
    let clean = newCode.trim().toUpperCase();
    if (!clean.startsWith('EXP-') && !clean.startsWith('ROOM-')) {
      clean = 'EXP-' + clean;
    }
    this.syncRoomId = clean;
    localStorage.setItem('expensesnap_room_id', clean);
    this.peerHeartbeats.clear();

    if (this.enabled) {
      if (this.mqttClient) {
        const old = this.mqttClient;
        this.mqttClient = null;
        old.onConnectionLost = () => {};
        try { old.disconnect(); } catch (e) {}
      }
      this.isConnected = false;
      clearTimeout(this.reconnectTimer);
      this.connect();
    }
    this.notifyStatus();
  }

  connect() {
    if (!this.enabled) return; // never touch the relay while Sync is off
    if (!window.Paho || !window.Paho.MQTT) {
      console.warn('Paho MQTT library not loaded; sync cannot connect.');
      this.status = 'offline';
      this.notifyStatus();
      return;
    }

    const host = 'broker.hivemq.com';
    const port = 8884; // WSS SSL port
    const path = '/mqtt';
    const clientId = 'ExpenseSnap_' + this.deviceId;

    this.status = 'connecting';
    this.notifyStatus();

    try {
      const client = new window.Paho.MQTT.Client(host, port, path, clientId);
      this.mqttClient = client;

      client.onConnectionLost = (responseObject) => {
        if (this.mqttClient !== client) return;
        this.isConnected = false;
        this.status = 'offline';
        this.peerHeartbeats.clear();
        this.notifyStatus();
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connect(), 4000);
      };

      client.onMessageArrived = (message) => {
        if (this.mqttClient !== client) return;
        this._handleIncomingMessage(message);
      };

      client.connect({
        useSSL: true,
        timeout: 8,
        keepAliveInterval: 30,
        cleanSession: true,
        onSuccess: () => {
          if (this.mqttClient !== client) {
            try { client.disconnect(); } catch (e) {}
            return;
          }
          this.isConnected = true;
          this.status = 'online';
          
          const topic = `expensesnap/app_v2/${this.syncRoomId}/#`;
          this.mqttClient.subscribe(topic, { qos: 0 });

          // Announce presence
          this.publish('presence', { type: 'JOIN', deviceId: this.deviceId, timestamp: Date.now() });
          this.publish('sync', { type: 'REQUEST_DATA', senderId: this.deviceId });

          this.notifyStatus();
        },
        onFailure: (err) => {
          if (this.mqttClient !== client) return;
          console.warn('MQTT Connection failed:', err);
          this.isConnected = false;
          this.status = 'offline';
          this.notifyStatus();
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => this.connect(), 8000);
        }
      });
    } catch (err) {
      console.error('MQTT setup error:', err);
      this.status = 'offline';
      this.notifyStatus();
    }
  }

  publish(subtopic, data) {
    if (!this.isConnected || !this.mqttClient) return;
    try {
      const topic = `expensesnap/app_v2/${this.syncRoomId}/${subtopic}`;
      const payload = JSON.stringify({
        ...data,
        senderId: this.deviceId,
        roomId: this.syncRoomId
      });
      const msg = new window.Paho.MQTT.Message(payload);
      msg.destinationName = topic;
      this.mqttClient.send(msg);
    } catch (e) {
      console.warn('Publish error:', e);
    }
  }

  // Broadcast receipt changes to other devices
  broadcastReceiptAdded(receipt) {
    this.publish('sync', { type: 'RECEIPT_ADDED', receipt });
  }

  broadcastReceiptUpdated(receipt) {
    this.publish('sync', { type: 'RECEIPT_UPDATED', receipt });
  }

  broadcastReceiptDeleted(receiptId) {
    this.publish('sync', { type: 'RECEIPT_DELETED', receiptId });
  }

  broadcastReceiptsReordered(reportId, orderedIds) {
    this.publish('sync', { type: 'RECEIPTS_REORDERED', reportId, orderedIds });
  }

  cleanStalePeers() {
    const now = Date.now();
    let changed = false;
    for (const [id, lastSeen] of this.peerHeartbeats.entries()) {
      if (now - lastSeen > 18000) { // stale after 18 seconds without a ping
        this.peerHeartbeats.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.notifyStatus();
    }
  }

  async _handleIncomingMessage(message) {
    try {
      const payload = JSON.parse(message.payloadString);
      if (payload.senderId === this.deviceId) return; // Ignore own echoes

      // Record heartbeat for this peer
      if (payload.senderId) {
        this.peerHeartbeats.set(payload.senderId, Date.now());
      }

      if (payload.type === 'LEAVE') {
        this.peerHeartbeats.delete(payload.deviceId || payload.senderId);
        this.notifyStatus();
        return;
      }

      if (payload.type === 'PING' || payload.type === 'JOIN') {
        this.notifyStatus();
        if (payload.type === 'JOIN') {
          // Greet back so peer knows we are here
          this.publish('presence', { type: 'PING', deviceId: this.deviceId, timestamp: Date.now() });
        }
      } else if (payload.type === 'REQUEST_DATA') {
        // Peer requested data: send our active report and receipts
        const activeReport = await window.store.getActiveReport();
        if (activeReport) {
          // Receipts are one list now, so share all of them
          const receipts = await window.store.getAllReceipts();
          this.publish('sync', {
            type: 'SEND_FULL_DATA',
            targetId: payload.senderId,
            report: activeReport,
            receipts: receipts
          });
        }
      } else if (payload.type === 'SEND_FULL_DATA') {
        if (payload.targetId === this.deviceId) {
          await window.store.applyFullSync(payload.report, payload.receipts);
          if (window.expenseApp) {
            window.expenseApp.showToast(`Synced ${payload.receipts?.length || 0} receipts from peer!`, 'success');
          }
        }
      } else if (payload.type === 'RECEIPT_ADDED') {
        await window.store.upsertReceiptFromSync(payload.receipt);
        if (window.expenseApp) {
          window.expenseApp.showToast(`Receipt from ${payload.receipt.merchant || 'phone'} received!`, 'success');
        }
      } else if (payload.type === 'RECEIPT_UPDATED') {
        await window.store.upsertReceiptFromSync(payload.receipt);
      } else if (payload.type === 'RECEIPT_DELETED') {
        await window.store.deleteReceiptFromSync(payload.receiptId);
      } else if (payload.type === 'RECEIPTS_REORDERED') {
        await window.store.setReceiptOrder(payload.reportId, payload.orderedIds);
      }
    } catch (err) {
      console.warn('Error handling incoming sync message:', err);
    }
  }

  getStatus() {
    this.cleanStalePeers();
    const peerCount = this.peerHeartbeats.size;
    let label = 'Local Mode'; // Sync is off: nothing leaves this device
    let isLive = false;

    if (!this.enabled) {
      label = 'Local Mode';
    } else if (this.isConnected) {
      if (peerCount === 1) {
        label = 'Synced (2 devices)';
        isLive = true;
      } else if (peerCount > 1) {
        label = `Synced (${peerCount + 1} devices)`;
        isLive = true;
      } else {
        label = 'Online (Waiting for phone)';
        isLive = true;
      }
    } else if (this.status === 'connecting') {
      label = 'Connecting...';
    } else {
      label = 'Sync offline';
    }

    return {
      status: this.status,
      enabled: this.enabled,
      roomCode: this.syncRoomId,
      pairingLink: this.getPairingLink(),
      peersCount: peerCount,
      label: label,
      isLive: isLive
    };
  }

  notifyStatus() {
    const statusObj = this.getStatus();
    for (const cb of this.listeners) {
      try { cb(statusObj); } catch (e) {}
    }
  }

  onStatusChange(cb) {
    this.listeners.push(cb);
    cb(this.getStatus());
  }
}

window.cloudSyncManager = new CloudSyncManager();
