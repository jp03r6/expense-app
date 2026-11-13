/**
 * ExpenseSnap - Cloud Sync & Multi-Device Pairing (Firebase / Realtime Cloud)
 */

class CloudSyncManager {
  constructor() {
    this.status = 'local'; // 'local', 'connecting', 'synced', 'error'
    this.config = null;
    this.syncRoomId = null;
    this.listeners = [];
  }

  async init() {
    // Check if cloud sync credentials or room ID exist in storage
    const savedConfig = localStorage.getItem('expensesnap_firebase_config');
    const savedRoom = localStorage.getItem('expensesnap_room_id');

    if (savedConfig) {
      try {
        this.config = JSON.parse(savedConfig);
      } catch (e) {}
    }

    if (savedRoom) {
      this.syncRoomId = savedRoom;
    } else {
      // Generate a default 6-character room code for simple pairing
      this.syncRoomId = this.generateRoomCode();
      localStorage.setItem('expensesnap_room_id', this.syncRoomId);
    }

    // Check URL parameters for ?room=XXXXXX pairing code
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('room')) {
      const roomFromUrl = urlParams.get('room').toUpperCase();
      this.syncRoomId = roomFromUrl;
      localStorage.setItem('expensesnap_room_id', roomFromUrl);
    }
  }

  generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  getPairingLink() {
    const base = window.location.origin + window.location.pathname;
    return `${base}?room=${this.syncRoomId}`;
  }

  setRoomCode(newCode) {
    if (!newCode || newCode.trim().length < 4) {
      throw new Error('Room code must be at least 4 characters.');
    }
    this.syncRoomId = newCode.trim().toUpperCase();
    localStorage.setItem('expensesnap_room_id', this.syncRoomId);
    this.notifyStatus('synced');
  }

  saveFirebaseConfig(cfg) {
    this.config = cfg;
    localStorage.setItem('expensesnap_firebase_config', JSON.stringify(cfg));
    this.notifyStatus('synced');
  }

  getStatus() {
    return {
      status: this.status,
      roomCode: this.syncRoomId,
      pairingLink: this.getPairingLink(),
      hasConfig: !!this.config
    };
  }

  notifyStatus(status) {
    this.status = status;
    for (const cb of this.listeners) {
      cb(this.getStatus());
    }
  }

  onStatusChange(cb) {
    this.listeners.push(cb);
    cb(this.getStatus());
  }
}

window.cloudSyncManager = new CloudSyncManager();
