/**
 * ExpenseSnap - Real-time Multi-Device Cloud Sync & QR Pairing
 * Powered by MQTT over WebSocket (WSS) - Free, Zero-Config, Instant Device-to-Device Linking
 */

class CloudSyncManager {
  constructor() {
    this.status = 'local'; // 'local', 'connecting', 'online', 'synced', 'error'
    this.syncRoomId = null;
    this.deviceId = 'dev_' + Math.random().toString(36).substr(2, 9);
    this.mqttClient = null;
    this.peers = new Set();
    this.listeners = [];
    this.isConnected = false;
    this.reconnectTimer = null;
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

    // 2. Connect to public real-time MQTT broker over WebSocket
    this.connect();

    // 3. Setup periodic presence heartbeat
    setInterval(() => {
      if (this.isConnected) {
        this.publish('presence', { type: 'PING', deviceId: this.deviceId, timestamp: Date.now() });
      }
    }, 12000);
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
    // Use current origin and path, preserving GitHub Pages subfolder
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
    this.peers.clear();

    if (this.mqttClient && this.isConnected) {
      try { this.mqttClient.disconnect(); } catch (e) {}
    }
    this.connect();
    this.notifyStatus();
  }

  connect() {
    if (!window.Paho || !window.Paho.MQTT) {
      console.warn('Paho MQTT library not loaded; falling back to local mode.');
      this.status = 'local';
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
      this.mqttClient = new window.Paho.MQTT.Client(host, port, path, clientId);

      this.mqttClient.onConnectionLost = (responseObject) => {
        this.isConnected = false;
        this.status = 'local';
        this.notifyStatus();
        // Auto-reconnect after 4s
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connect(), 4000);
      };

      this.mqttClient.onMessageArrived = (message) => {
        this._handleIncomingMessage(message);
      };

      this.mqttClient.connect({
        useSSL: true,
        timeout: 8,
        keepAliveInterval: 30,
        cleanSession: true,
        onSuccess: () => {
          this.isConnected = true;
          this.status = 'online';
          
          // Subscribe to this room's channel
          const topic = `expensesnap/v2/${this.syncRoomId}/#`;
          this.mqttClient.subscribe(topic, { qos: 0 });

          // Announce presence and request current data if joining
          this.publish('presence', { type: 'JOIN', deviceId: this.deviceId, timestamp: Date.now() });
          this.publish('sync', { type: 'REQUEST_DATA', senderId: this.deviceId });

          this.notifyStatus();
        },
        onFailure: (err) => {
          console.warn('MQTT Connection failed:', err);
          this.isConnected = false;
          this.status = 'local';
          this.notifyStatus();
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => this.connect(), 8000);
        }
      });
    } catch (err) {
      console.error('MQTT setup error:', err);
      this.status = 'local';
      this.notifyStatus();
    }
  }

  publish(subtopic, data) {
    if (!this.isConnected || !this.mqttClient) return;
    try {
      const topic = `expensesnap/v2/${this.syncRoomId}/${subtopic}`;
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

  async _handleIncomingMessage(message) {
    try {
      const payload = JSON.parse(message.payloadString);
      if (payload.senderId === this.deviceId) return; // Ignore own echoes

      if (payload.type === 'PING' || payload.type === 'JOIN') {
        this.peers.add(payload.senderId);
        this.status = 'synced';
        this.notifyStatus();
        if (payload.type === 'JOIN') {
          // Greet back so peer knows we are here
          this.publish('presence', { type: 'PING', deviceId: this.deviceId, timestamp: Date.now() });
        }
      } else if (payload.type === 'REQUEST_DATA') {
        // Peer requested data: send our active report and receipts
        const activeReport = await window.store.getActiveReport();
        if (activeReport) {
          const receipts = await window.store.getReceiptsForReport(activeReport.id);
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
    const peerCount = this.peers.size;
    let label = 'Local Mode';
    let isLive = false;

    if (this.isConnected) {
      if (peerCount > 0) {
        label = `Synced (${peerCount + 1} devices)`;
        isLive = true;
      } else {
        label = `Online (Waiting for peer)`;
        isLive = true;
      }
    } else if (this.status === 'connecting') {
      label = 'Connecting...';
    }

    return {
      status: this.status,
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
