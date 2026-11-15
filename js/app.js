/**
 * ExpenseSnap - Main UI Application Controller
 */

class ExpenseApp {
  constructor() {
    this.currentReceipts = [];
    this.currentReport = null;
    this.selectedLayout = 'full';
    this.activeTab = 'tab-receipts';
    
    // Receipt form state
    this.stagedFile = null;
    this.stagedReceiptData = null;
    this.editingReceiptId = null;

    // PDF Preview state
    this.previewPdfDoc = null;
    this.previewCurrentPage = 1;
    this.previewTotalPages = 1;
  }

  async init() {
    // 1. Initialize IndexedDB Store
    await window.store.init();
    await window.cloudSyncManager.init();

    // 2. Register Service Worker for PWA
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(err => {
        console.warn('Service worker registration failed:', err);
      });
    }

    // 3. Bind UI Events
    this._bindEvents();
    this.initTheme();

    // 4. Subscribe to Store updates
    window.store.subscribe((event, data) => {
      this.handleStoreUpdate(event, data);
    });

    // 5. Initial Data Load
    await this.refreshAll();

    // 6. Setup Cloud Sync & QR Pairing
    window.cloudSyncManager.onStatusChange((status) => {
      this.handleSyncStatusChange(status);
    });
    this.renderQrCode();
  }

  initTheme() {
    const savedTheme = localStorage.getItem('expensesnap_theme') || 
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    this.applyTheme(savedTheme);

    const toggleBtn = document.getElementById('btnThemeToggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme') || 'light';
        const next = current === 'dark' ? 'light' : 'dark';
        this.applyTheme(next);
        localStorage.setItem('expensesnap_theme', next);
        this.showToast(`Switched to ${next} mode`, 'info');
      });
    }
  }

  applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const icon = document.getElementById('themeIcon');
    if (icon) {
      icon.textContent = theme === 'dark' ? '☀️' : '🌙';
    }
  }

  renderQrCode() {
    const box = document.getElementById('syncQrCodeBox');
    if (!box) return;
    const link = window.cloudSyncManager.getPairingLink();
    box.innerHTML = '';

    if (window.QRCode) {
      new window.QRCode(box, {
        text: link,
        width: 180,
        height: 180,
        colorDark: '#0f172a',
        colorLight: '#ffffff',
        correctLevel: window.QRCode.CorrectLevel.M
      });
    } else {
      box.innerHTML = `<a href="${link}" target="_blank" style="word-break: break-all; font-size: 0.8rem; color: var(--primary);">${link}</a>`;
    }

    const displayRoom = document.getElementById('displayRoomCode');
    if (displayRoom) displayRoom.textContent = window.cloudSyncManager.syncRoomId;
  }

  handleSyncStatusChange(status) {
    const headerSyncText = document.getElementById('syncText');
    const headerSyncBadge = document.getElementById('syncBadge');
    const liveBadge = document.getElementById('syncLiveStatusBadge');
    const liveText = document.getElementById('syncLiveStatusText');

    if (headerSyncText) headerSyncText.textContent = status.label;
    if (liveText) liveText.textContent = status.label;

    const isSynced = status.peersCount > 0;
    const isLive = status.isLive;

    [headerSyncBadge, liveBadge].forEach(b => {
      if (!b) return;
      b.classList.toggle('synced', isSynced);
      b.classList.toggle('online', isLive && !isSynced);
      b.classList.toggle('syncing', status.status === 'connecting');
    });

    const displayRoom = document.getElementById('displayRoomCode');
    if (displayRoom) displayRoom.textContent = status.roomCode;
  }

  startQrScanner() {
    this.openModal('modalQrScanner');
    const video = document.getElementById('qrScannerVideo');
    const canvas = document.getElementById('qrScannerCanvas');
    const ctx = canvas.getContext('2d');
    this.scanningActive = true;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.stopQrScanner();
      this.showToast('Camera not supported in this browser.', 'error');
      return;
    }

    navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
    }).then(stream => {
      this.scannerStream = stream;
      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      video.play();

      const scanFrame = async () => {
        if (!this.scanningActive) return;
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          // 1. Try native BarcodeDetector if available
          if ('BarcodeDetector' in window) {
            try {
              if (!this.barcodeDetector) {
                this.barcodeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
              }
              const codes = await this.barcodeDetector.detect(video);
              if (codes.length > 0) {
                this.handleScannedQr(codes[0].rawValue);
                return;
              }
            } catch (e) {}
          }

          // 2. Fallback to jsQR
          if (window.jsQR) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = window.jsQR(imgData.data, imgData.width, imgData.height, {
              inversionAttempts: "dontInvert"
            });
            if (code && code.data) {
              this.handleScannedQr(code.data);
              return;
            }
          }
        }
        requestAnimationFrame(scanFrame);
      };
      requestAnimationFrame(scanFrame);
    }).catch(err => {
      this.stopQrScanner();
      this.showToast('Camera error: ' + err.message, 'error');
    });
  }

  stopQrScanner() {
    this.scanningActive = false;
    if (this.scannerStream) {
      this.scannerStream.getTracks().forEach(t => t.stop());
      this.scannerStream = null;
    }
    this.closeModal('modalQrScanner');
  }

  handleScannedQr(rawData) {
    this.stopQrScanner();
    if (navigator.vibrate) {
      try { navigator.vibrate([60, 40, 60]); } catch (e) {}
    }

    let roomCode = rawData.trim();
    try {
      if (rawData.includes('?')) {
        const url = new URL(rawData, window.location.origin);
        const r = url.searchParams.get('room');
        if (r) roomCode = r;
      }
    } catch (e) {}

    window.cloudSyncManager.setRoomCode(roomCode);
    this.renderQrCode();
    this.showToast(`🎉 Connected to ${roomCode}! Syncing in real-time...`, 'success');
  }

  _bindEvents() {
    // Navigation Tabs (Desktop & Mobile)
    document.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tabId = btn.getAttribute('data-tab');
        this.switchTab(tabId);
      });
    });

    // Report Selector Dropdown
    const reportSelect = document.getElementById('reportSelect');
    reportSelect.addEventListener('change', async (e) => {
      await window.store.setActiveReport(e.target.value);
    });

    // New Report Modals
    document.getElementById('btnNewReport').addEventListener('click', () => {
      this.openModal('modalNewReport');
    });

    document.getElementById('btnCreateReportSubmit').addEventListener('click', async () => {
      const titleInput = document.getElementById('inputReportTitle');
      const submitterInput = document.getElementById('inputReportSubmitter');
      if (!titleInput.value.trim()) {
        this.showToast('Please enter a report title', 'error');
        return;
      }
      const newRep = await window.store.createReport(titleInput.value.trim(), {
        submitterName: submitterInput.value.trim()
      });
      await window.store.setActiveReport(newRep.id);
      titleInput.value = '';
      submitterInput.value = '';
      this.closeModal('modalNewReport');
      this.showToast('Report created successfully!', 'success');
    });

    // Add Receipt Buttons
    const openAddModal = () => {
      this.editingReceiptId = null;
      this.stagedReceiptData = null;
      document.getElementById('modalReceiptTitle').textContent = 'Add Receipt or PDF';
      document.getElementById('uploadPreviewSection').style.display = 'none';
      document.getElementById('dropzone').style.display = 'block';
      document.getElementById('inputDate').value = new Date().toISOString().split('T')[0];
      document.getElementById('inputAmount').value = '';
      document.getElementById('inputMerchant').value = '';
      document.getElementById('inputNotes').value = '';
      this.openModal('modalAddReceipt');
    };

    document.getElementById('btnAddReceipt').addEventListener('click', openAddModal);
    document.getElementById('btnAddReceiptHeader').addEventListener('click', openAddModal);
    document.getElementById('btnEmptyAdd').addEventListener('click', openAddModal);
    document.getElementById('fabAddReceipt').addEventListener('click', openAddModal);

    // Dropzone & File Input
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('fileInput');

    dropzone.addEventListener('click', () => fileInput.click());

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });

    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('drag-over');
    });

    dropzone.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        await this.handleFileUpload(e.dataTransfer.files[0]);
      }
    });

    fileInput.addEventListener('change', async (e) => {
      if (e.target.files && e.target.files.length > 0) {
        await this.handleFileUpload(e.target.files[0]);
      }
    });

    // Rotate and enhance inside modal
    document.getElementById('btnModalRotate').addEventListener('click', async () => {
      if (!this.stagedReceiptData || !this.stagedReceiptData.dataUrl) return;
      const currentRot = (this.stagedReceiptData.rotation || 0) + 90;
      this.stagedReceiptData.rotation = currentRot % 360;
      
      const opt = await window.receiptManager.optimizeImage(
        this.stagedReceiptData.dataUrl,
        90,
        this.stagedReceiptData.enhanceContrast
      );
      this.stagedReceiptData.dataUrl = opt.dataUrl;
      this.stagedReceiptData.thumbnailDataUrl = opt.thumbnailUrl;
      document.getElementById('uploadPreviewImg').src = opt.dataUrl;
    });

    document.getElementById('btnModalEnhance').addEventListener('click', async () => {
      if (!this.stagedReceiptData || !this.stagedReceiptData.dataUrl) return;
      this.stagedReceiptData.enhanceContrast = !this.stagedReceiptData.enhanceContrast;
      
      const opt = await window.receiptManager.optimizeImage(
        this.stagedReceiptData.dataUrl,
        0,
        this.stagedReceiptData.enhanceContrast
      );
      this.stagedReceiptData.dataUrl = opt.dataUrl;
      this.stagedReceiptData.thumbnailDataUrl = opt.thumbnailUrl;
      document.getElementById('uploadPreviewImg').src = opt.dataUrl;
      this.showToast(this.stagedReceiptData.enhanceContrast ? 'Thermal contrast boost ON' : 'Standard contrast restored', 'info');
    });

    // Save Receipt to Store
    document.getElementById('btnSaveReceipt').addEventListener('click', async () => {
      const date = document.getElementById('inputDate').value;
      const amount = parseFloat(document.getElementById('inputAmount').value) || 0;
      const merchant = document.getElementById('inputMerchant').value.trim() || 'Receipt';
      const category = document.getElementById('inputCategory').value;
      const paymentMethod = document.getElementById('inputPayment').value;
      const notes = document.getElementById('inputNotes').value.trim();

      if (!this.stagedReceiptData && !this.editingReceiptId) {
        this.showToast('Please take a photo or upload a receipt file first.', 'error');
        return;
      }

      if (this.editingReceiptId) {
        // Update existing receipt
        const updated = await window.store.updateReceipt(this.editingReceiptId, {
          date,
          amount,
          merchant,
          category,
          paymentMethod,
          notes
        });
        if (updated) window.cloudSyncManager.broadcastReceiptUpdated(updated);
        this.showToast('Receipt updated', 'success');
      } else {
        // Add new receipt
        const added = await window.store.addReceipt({
          ...this.stagedReceiptData,
          date,
          amount,
          merchant,
          category,
          paymentMethod,
          notes
        });
        if (added) window.cloudSyncManager.broadcastReceiptAdded(added);
        this.showToast('Receipt added to report', 'success');
      }

      this.closeModal('modalAddReceipt');
    });

    // Quick Sample Demo Receipts Button
    document.getElementById('btnQuickSample').addEventListener('click', async () => {
      await this.loadSampleReceipts();
    });

    // Spreadsheet Companion: 1-Click Copy for Excel
    document.getElementById('btnCopyExcel').addEventListener('click', async () => {
      try {
        const res = await window.spreadsheetHelper.copyTableForExcel(this.currentReceipts, true);
        this.showToast(`✅ Copied ${res.count} rows to clipboard! Just press Ctrl+V in your company Excel sheet.`, 'success');
      } catch (err) {
        this.showToast('Failed to copy: ' + err.message, 'error');
      }
    });

    // Spreadsheet Companion: Export .xlsx
    document.getElementById('btnExportXlsx').addEventListener('click', () => {
      try {
        window.spreadsheetHelper.exportToExcel(this.currentReport, this.currentReceipts);
        this.showToast('Excel workbook downloaded', 'success');
      } catch (err) {
        this.showToast('Export failed: ' + err.message, 'error');
      }
    });

    // Spreadsheet Companion: Export CSV
    document.getElementById('btnExportCsv').addEventListener('click', () => {
      try {
        window.spreadsheetHelper.exportToCsv(this.currentReport, this.currentReceipts);
        this.showToast('CSV downloaded', 'success');
      } catch (err) {
        this.showToast('Export failed: ' + err.message, 'error');
      }
    });

    // PDF Layout Options Picker
    document.querySelectorAll('.layout-card').forEach(card => {
      card.addEventListener('click', () => {
        document.querySelectorAll('.layout-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        this.selectedLayout = card.getAttribute('data-layout');
      });
    });

    // PDF Compilation & Download
    document.getElementById('btnCompilePdf').addEventListener('click', async () => {
      await this.compileAndDownloadPdf();
    });

    document.getElementById('btnPreviewPdf').addEventListener('click', async () => {
      await this.refreshPdfPreview();
    });

    // PDF Preview Pagination
    document.getElementById('btnPrevPage').addEventListener('click', () => {
      if (this.previewCurrentPage > 1) {
        this.previewCurrentPage--;
        this.renderPreviewPage(this.previewCurrentPage);
      }
    });

    document.getElementById('btnNextPage').addEventListener('click', () => {
      if (this.previewCurrentPage < this.previewTotalPages) {
        this.previewCurrentPage++;
        this.renderPreviewPage(this.previewCurrentPage);
      }
    });

    // Sync Badge in Header
    const syncBadge = document.getElementById('syncBadge');
    if (syncBadge) {
      syncBadge.addEventListener('click', () => {
        this.switchTab('tab-settings');
        this.renderQrCode();
      });
    }

    // In-App QR Scanner Trigger & Close
    const btnOpenQr = document.getElementById('btnOpenQrScanner');
    if (btnOpenQr) {
      btnOpenQr.addEventListener('click', () => this.startQrScanner());
    }
    const btnCloseQr = document.getElementById('btnCloseQrScanner');
    if (btnCloseQr) {
      btnCloseQr.addEventListener('click', () => this.stopQrScanner());
    }
    const btnCancelScan = document.getElementById('btnCancelScan');
    if (btnCancelScan) {
      btnCancelScan.addEventListener('click', () => this.stopQrScanner());
    }

    // Multi-Device Cloud Sync Controls
    document.getElementById('btnCopyPairLink').addEventListener('click', () => {
      const link = window.cloudSyncManager.getPairingLink();
      navigator.clipboard.writeText(link);
      this.showToast('Sync link copied! Open on your phone to link.', 'success');
    });

    const btnNewRoom = document.getElementById('btnNewRoomCode');
    if (btnNewRoom) {
      btnNewRoom.addEventListener('click', () => {
        const newCode = window.cloudSyncManager.generateRoomCode();
        window.cloudSyncManager.setRoomCode(newCode);
        this.renderQrCode();
        this.showToast('New room generated: ' + newCode, 'info');
      });
    }

    document.getElementById('btnJoinRoom').addEventListener('click', () => {
      const code = document.getElementById('inputJoinRoom').value.trim();
      if (code) {
        window.cloudSyncManager.setRoomCode(code);
        this.renderQrCode();
        this.showToast(`Joined sync room ${window.cloudSyncManager.syncRoomId}!`, 'success');
      }
    });

    // Backup & Restore
    document.getElementById('btnExportBackup').addEventListener('click', async () => {
      const backupJson = await window.store.exportFullBackup();
      const blob = new Blob([backupJson], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `ExpenseSnap_Backup_${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      this.showToast('Backup file downloaded', 'success');
    });

    document.getElementById('inputRestoreBackup').addEventListener('change', async (e) => {
      if (e.target.files && e.target.files.length > 0) {
        const file = e.target.files[0];
        const text = await file.text();
        try {
          await window.store.importFullBackup(text);
          this.showToast('Backup restored successfully!', 'success');
          await this.refreshAll();
        } catch (err) {
          this.showToast('Failed to restore backup: ' + err.message, 'error');
        }
      }
    });

    // Generic Modal Close Buttons
    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const modal = e.target.closest('.modal-overlay');
        if (modal) modal.classList.remove('open');
      });
    });

    // Close modal on background click
    document.querySelectorAll('.modal-overlay').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.remove('open');
      });
    });
  }

  switchTab(tabId) {
    this.activeTab = tabId;
    
    // Update Desktop Tabs
    document.querySelectorAll('.nav-tabs .tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
    });

    // Update Mobile Nav
    document.querySelectorAll('.mobile-nav-bar .mobile-nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
    });

    // Update View Containers
    document.querySelectorAll('.tab-view').forEach(view => {
      view.classList.toggle('active', view.id === tabId);
    });

    // If PDF tab selected, trigger preview refresh
    if (tabId === 'tab-pdf') {
      this.refreshPdfPreview();
    }

    // If Settings tab selected, re-render QR code
    if (tabId === 'tab-settings') {
      this.renderQrCode();
    }
  }

  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('open');
  }

  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('open');
  }

  async handleFileUpload(file) {
    try {
      this.showToast('Processing file...', 'info');
      const processed = await window.receiptManager.processFile(file);
      this.stagedReceiptData = processed;

      // Populate modal form fields with inferred smart defaults
      document.getElementById('inputDate').value = processed.date;
      document.getElementById('inputMerchant').value = processed.merchant;
      document.getElementById('inputCategory').value = processed.category;
      document.getElementById('inputNotes').value = processed.notes;

      // Show preview
      const previewImg = document.getElementById('uploadPreviewImg');
      previewImg.src = processed.dataUrl || processed.thumbnailDataUrl;
      document.getElementById('uploadPreviewSection').style.display = 'flex';
      document.getElementById('dropzone').style.display = 'none';

      this.showToast('Receipt loaded! Fill details and save.', 'success');
    } catch (err) {
      console.error(err);
      this.showToast('Error processing file: ' + err.message, 'error');
    }
  }

  async handleStoreUpdate(event, data) {
    await this.refreshAll();
  }

  async refreshAll() {
    // 1. Refresh Reports Dropdown
    const reports = await window.store.getAllReports();
    const activeRep = await window.store.getActiveReport();
    this.currentReport = activeRep;

    const reportSelect = document.getElementById('reportSelect');
    reportSelect.innerHTML = '';
    reports.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = r.title;
      if (activeRep && r.id === activeRep.id) opt.selected = true;
      reportSelect.appendChild(opt);
    });

    if (!activeRep) return;

    // Submitter Name prefill
    if (activeRep.submitterName) {
      document.getElementById('pdfSubmitterName').value = activeRep.submitterName;
    }

    // 2. Refresh Receipts
    this.currentReceipts = await window.store.getReceiptsForReport(activeRep.id);

    // 3. Calculate Totals
    let total = 0;
    this.currentReceipts.forEach(r => {
      total += parseFloat(r.amount) || 0;
    });

    const totalFormatted = `$${total.toFixed(2)}`;
    document.getElementById('headerTotal').textContent = totalFormatted;
    document.getElementById('ledgerTotal').textContent = totalFormatted;
    document.getElementById('ledgerCount').textContent = this.currentReceipts.length;
    document.getElementById('badgeReceiptCount').textContent = this.currentReceipts.length;

    // 4. Render Receipts Grid
    this.renderReceiptsGrid();

    // 5. Render Spreadsheet Ledger Table
    this.renderLedgerTable();
  }

  renderReceiptsGrid() {
    const grid = document.getElementById('receiptsGrid');
    const emptyState = document.getElementById('emptyReceipts');

    if (this.currentReceipts.length === 0) {
      grid.style.display = 'none';
      emptyState.style.display = 'block';
      return;
    }

    grid.style.display = 'grid';
    emptyState.style.display = 'none';
    grid.innerHTML = '';

    this.currentReceipts.forEach((r, idx) => {
      const card = document.createElement('div');
      card.className = 'receipt-card';

      const typeBadgeClass = r.type === 'pdf' ? 'type-pdf' : 'type-img';
      const typeLabel = r.type === 'pdf' ? 'PDF' : 'IMAGE';

      card.innerHTML = `
        <div class="receipt-card-header">
          <span class="receipt-num">ITEM #${idx + 1}</span>
          <span class="receipt-type-badge ${typeBadgeClass}">${typeLabel}</span>
        </div>
        <div class="receipt-thumb-wrapper" title="Click to inspect receipt">
          <img class="receipt-thumb" src="${r.thumbnailDataUrl || r.dataUrl}" alt="${r.merchant}">
        </div>
        <div class="receipt-card-body">
          <div class="receipt-merchant">${this._escape(r.merchant)}</div>
          <div class="receipt-meta">
            <span>📅 ${r.date || 'No Date'}</span>
            <span class="receipt-amount">$${(parseFloat(r.amount) || 0).toFixed(2)}</span>
          </div>
          <div style="font-size: 0.75rem; color: var(--text-muted);">${this._escape(r.category)}</div>
        </div>
        <div class="receipt-card-footer">
          <div class="card-actions">
            <button class="btn btn-secondary btn-sm btn-icon btn-move-up" title="Move Up" ${idx === 0 ? 'disabled' : ''}>▲</button>
            <button class="btn btn-secondary btn-sm btn-icon btn-move-down" title="Move Down" ${idx === this.currentReceipts.length - 1 ? 'disabled' : ''}>▼</button>
            <button class="btn btn-secondary btn-sm btn-icon btn-quick-rotate" title="Rotate 90°">🔄</button>
          </div>
          <div class="card-actions">
            <button class="btn btn-secondary btn-sm btn-edit">Edit</button>
            <button class="btn btn-danger btn-sm btn-delete">✕</button>
          </div>
        </div>
      `;

      // Zoom viewer
      card.querySelector('.receipt-thumb-wrapper').addEventListener('click', () => {
        document.getElementById('zoomTitle').textContent = `${r.merchant} - $${(parseFloat(r.amount) || 0).toFixed(2)}`;
        document.getElementById('zoomImg').src = r.dataUrl || r.thumbnailDataUrl;
        this.openModal('modalZoom');
      });

      // Quick Rotate
      card.querySelector('.btn-quick-rotate').addEventListener('click', async (e) => {
        e.stopPropagation();
        const currentRot = (r.rotation || 0) + 90;
        const opt = await window.receiptManager.optimizeImage(r.dataUrl, 90, r.enhanceContrast);
        const updated = await window.store.updateReceipt(r.id, {
          rotation: currentRot % 360,
          dataUrl: opt.dataUrl,
          thumbnailDataUrl: opt.thumbnailUrl
        });
        if (updated) window.cloudSyncManager.broadcastReceiptUpdated(updated);
        this.showToast('Receipt rotated 90°', 'info');
      });

      // Move Up
      card.querySelector('.btn-move-up').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (idx > 0) {
          const ids = this.currentReceipts.map(item => item.id);
          [ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]];
          await window.store.setReceiptOrder(this.currentReport.id, ids);
          window.cloudSyncManager.broadcastReceiptsReordered(this.currentReport.id, ids);
        }
      });

      // Move Down
      card.querySelector('.btn-move-down').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (idx < this.currentReceipts.length - 1) {
          const ids = this.currentReceipts.map(item => item.id);
          [ids[idx + 1], ids[idx]] = [ids[idx], ids[idx + 1]];
          await window.store.setReceiptOrder(this.currentReport.id, ids);
          window.cloudSyncManager.broadcastReceiptsReordered(this.currentReport.id, ids);
        }
      });

      // Edit Details
      card.querySelector('.btn-edit').addEventListener('click', (e) => {
        e.stopPropagation();
        this.editingReceiptId = r.id;
        document.getElementById('modalReceiptTitle').textContent = `Edit Receipt #${idx + 1}`;
        document.getElementById('inputDate').value = r.date || '';
        document.getElementById('inputAmount').value = r.amount || '';
        document.getElementById('inputMerchant').value = r.merchant || '';
        document.getElementById('inputCategory').value = r.category || 'Meals & Entertainment';
        document.getElementById('inputPayment').value = r.paymentMethod || 'Corporate Card';
        document.getElementById('inputNotes').value = r.notes || '';

        document.getElementById('uploadPreviewImg').src = r.dataUrl || r.thumbnailDataUrl;
        document.getElementById('uploadPreviewSection').style.display = 'flex';
        document.getElementById('dropzone').style.display = 'none';

        this.openModal('modalAddReceipt');
      });

      // Delete
      card.querySelector('.btn-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Delete receipt from ${r.merchant}?`)) {
          await window.store.deleteReceipt(r.id);
          window.cloudSyncManager.broadcastReceiptDeleted(r.id);
          this.showToast('Receipt removed', 'info');
        }
      });

      grid.appendChild(card);
    });
  }

  renderLedgerTable() {
    const tbody = document.getElementById('ledgerTableBody');
    tbody.innerHTML = '';

    if (this.currentReceipts.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="9" style="text-align: center; color: var(--text-muted); padding: 30px;">
            No receipts added yet. Add receipts to automatically generate your spreadsheet.
          </td>
        </tr>
      `;
      return;
    }

    this.currentReceipts.forEach((r, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-weight: 700; color: var(--primary); text-align: center;">${idx + 1}</td>
        <td>
          <img class="table-thumb" src="${r.thumbnailDataUrl || r.dataUrl}" alt="Thumb" title="Click to view">
        </td>
        <td>
          <input type="date" class="table-input" value="${r.date || ''}" data-field="date">
        </td>
        <td>
          <input type="text" class="table-input" value="${this._escape(r.merchant)}" data-field="merchant">
        </td>
        <td>
          <select class="table-input" data-field="category">
            <option value="Transportation" ${r.category === 'Transportation' ? 'selected' : ''}>Transportation</option>
            <option value="Meals & Entertainment" ${r.category === 'Meals & Entertainment' ? 'selected' : ''}>Meals & Entertainment</option>
            <option value="Travel & Lodging" ${r.category === 'Travel & Lodging' ? 'selected' : ''}>Travel & Lodging</option>
            <option value="Office Supplies" ${r.category === 'Office Supplies' ? 'selected' : ''}>Office Supplies</option>
            <option value="Client Meeting" ${r.category === 'Client Meeting' ? 'selected' : ''}>Client Meeting</option>
            <option value="Other" ${r.category === 'Other' ? 'selected' : ''}>Other</option>
          </select>
        </td>
        <td>
          <select class="table-input" data-field="paymentMethod">
            <option value="Corporate Visa" ${r.paymentMethod === 'Corporate Visa' ? 'selected' : ''}>Corporate Visa</option>
            <option value="Personal Card (Reimburse)" ${r.paymentMethod === 'Personal Card (Reimburse)' ? 'selected' : ''}>Personal Card</option>
            <option value="Cash" ${r.paymentMethod === 'Cash' ? 'selected' : ''}>Cash</option>
            <option value="Company Account" ${r.paymentMethod === 'Company Account' ? 'selected' : ''}>Company Account</option>
          </select>
        </td>
        <td>
          <input type="number" step="0.01" class="table-input" value="${(parseFloat(r.amount) || 0).toFixed(2)}" data-field="amount" style="font-weight: 700; color: #047857;">
        </td>
        <td>
          <input type="text" class="table-input" value="${this._escape(r.notes || '')}" data-field="notes" placeholder="Notes...">
        </td>
        <td>
          <button class="btn btn-danger btn-sm btn-icon btn-table-del" title="Delete">✕</button>
        </td>
      `;

      // Zoom click
      tr.querySelector('.table-thumb').addEventListener('click', () => {
        document.getElementById('zoomTitle').textContent = `${r.merchant} - $${(parseFloat(r.amount) || 0).toFixed(2)}`;
        document.getElementById('zoomImg').src = r.dataUrl || r.thumbnailDataUrl;
        this.openModal('modalZoom');
      });

      // Inline auto-save for table edits
      tr.querySelectorAll('.table-input').forEach(input => {
        input.addEventListener('change', async (e) => {
          const field = e.target.getAttribute('data-field');
          let val = e.target.value;
          if (field === 'amount') val = parseFloat(val) || 0;

          const updated = await window.store.updateReceipt(r.id, { [field]: val });
          if (updated) window.cloudSyncManager.broadcastReceiptUpdated(updated);
          this.showToast('Ledger updated', 'info');
        });
      });

      // Delete from table
      tr.querySelector('.btn-table-del').addEventListener('click', async () => {
        if (confirm(`Remove receipt from ${r.merchant}?`)) {
          await window.store.deleteReceipt(r.id);
          window.cloudSyncManager.broadcastReceiptDeleted(r.id);
        }
      });

      tbody.appendChild(tr);
    });
  }

  async compileAndDownloadPdf() {
    if (this.currentReceipts.length === 0) {
      this.showToast('No receipts to compile.', 'error');
      return;
    }

    try {
      this.showToast('Assembling receipts into unified PDF...', 'info');
      const addCover = document.getElementById('chkAddCover').checked;
      const submitterName = document.getElementById('pdfSubmitterName').value.trim();
      const department = document.getElementById('pdfDepartment').value.trim();

      const blob = await window.pdfCompiler.compileReportPdf(
        {
          ...this.currentReport,
          submitterName,
          department
        },
        this.currentReceipts,
        {
          layout: this.selectedLayout,
          addCover: addCover
        }
      );

      // Trigger download
      const cleanTitle = (this.currentReport.title || 'Expense_Report').replace(/[^a-zA-Z0-9_-]/g, '_');
      const fileName = `${cleanTitle}_Receipts_${new Date().toISOString().split('T')[0]}.pdf`;

      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(link.href);

      this.showToast('Single compiled PDF downloaded successfully!', 'success');
    } catch (err) {
      console.error(err);
      this.showToast('Compilation error: ' + err.message, 'error');
    }
  }

  async refreshPdfPreview() {
    if (this.currentReceipts.length === 0) return;

    try {
      const addCover = document.getElementById('chkAddCover').checked;
      const submitterName = document.getElementById('pdfSubmitterName').value.trim();
      const department = document.getElementById('pdfDepartment').value.trim();

      const blob = await window.pdfCompiler.compileReportPdf(
        {
          ...this.currentReport,
          submitterName,
          department
        },
        this.currentReceipts,
        {
          layout: this.selectedLayout,
          addCover: addCover
        }
      );

      const arrayBuffer = await blob.arrayBuffer();
      this.previewPdfDoc = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      this.previewTotalPages = this.previewPdfDoc.numPages;
      this.previewCurrentPage = 1;

      await this.renderPreviewPage(1);
    } catch (err) {
      console.error('Preview error:', err);
    }
  }

  async renderPreviewPage(pageNum) {
    if (!this.previewPdfDoc) return;

    const page = await this.previewPdfDoc.getPage(pageNum);
    const canvas = document.getElementById('pdfPreviewCanvas');
    const ctx = canvas.getContext('2d');

    // Scale to fit nicely in panel
    const viewport = page.getViewport({ scale: 1.2 });
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({
      canvasContext: ctx,
      viewport: viewport
    }).promise;

    document.getElementById('previewPageIndicator').textContent = `Page ${pageNum} of ${this.previewTotalPages}`;
    document.getElementById('btnPrevPage').disabled = pageNum <= 1;
    document.getElementById('btnNextPage').disabled = pageNum >= this.previewTotalPages;
  }

  async loadSampleReceipts() {
    this.showToast('Generating demo receipts...', 'info');

    // Sample 1: Uber Rideshare Receipt (Digital style)
    const uberCanvas = document.createElement('canvas');
    uberCanvas.width = 600;
    uberCanvas.height = 800;
    const uCtx = uberCanvas.getContext('2d');
    uCtx.fillStyle = '#000000';
    uCtx.fillRect(0, 0, 600, 100);
    uCtx.fillStyle = '#ffffff';
    uCtx.font = 'bold 36px sans-serif';
    uCtx.fillText('Uber', 40, 65);
    uCtx.fillStyle = '#ffffff';
    uCtx.fillRect(0, 100, 600, 700);
    uCtx.fillStyle = '#1e293b';
    uCtx.font = 'bold 26px sans-serif';
    uCtx.fillText('Trip Receipt: Airport to Hotel', 40, 160);
    uCtx.font = '18px sans-serif';
    uCtx.fillStyle = '#64748b';
    uCtx.fillText('Date: 2026-11-10 18:42 EST', 40, 200);
    uCtx.fillText('Driver: Michael S. (Toyota Camry)', 40, 230);
    uCtx.strokeStyle = '#e2e8f0';
    uCtx.lineWidth = 2;
    uCtx.strokeRect(40, 270, 520, 260);
    uCtx.fillStyle = '#0f172a';
    uCtx.font = '20px sans-serif';
    uCtx.fillText('Trip Fare', 60, 320);
    uCtx.fillText('$28.50', 460, 320);
    uCtx.fillText('Tolls & Surcharges', 60, 370);
    uCtx.fillText('$4.25', 460, 370);
    uCtx.fillText('Tip', 60, 420);
    uCtx.fillText('$5.00', 460, 420);
    uCtx.font = 'bold 24px sans-serif';
    uCtx.fillText('Total Charged', 60, 490);
    uCtx.fillStyle = '#047857';
    uCtx.fillText('$37.75', 450, 490);
    const uberUrl = uberCanvas.toDataURL('image/jpeg', 0.9);

    // Sample 2: Restaurant Dinner Receipt (Paper thermal style)
    const restCanvas = document.createElement('canvas');
    restCanvas.width = 500;
    restCanvas.height = 700;
    const rCtx = restCanvas.getContext('2d');
    rCtx.fillStyle = '#faf8f5'; // Off-white receipt paper
    rCtx.fillRect(0, 0, 500, 700);
    rCtx.fillStyle = '#262626';
    rCtx.font = 'bold 26px monospace';
    rCtx.textAlign = 'center';
    rCtx.fillText('THE CAPITAL GRILLE', 250, 60);
    rCtx.font = '16px monospace';
    rCtx.fillText('1338 Chestnut St, Philadelphia PA', 250, 90);
    rCtx.fillText('Server: Sarah H. | Table: 14', 250, 120);
    rCtx.fillText('--------------------------------', 250, 150);
    rCtx.textAlign = 'left';
    rCtx.fillText('2  Bone-in Ribeye         124.00', 50, 190);
    rCtx.fillText('1  Lobster Mac & Cheese    22.00', 50, 220);
    rCtx.fillText('2  Sparkling Water         14.00', 50, 250);
    rCtx.fillText('1  Espresso                 6.00', 50, 280);
    rCtx.textAlign = 'center';
    rCtx.fillText('--------------------------------', 250, 320);
    rCtx.textAlign = 'left';
    rCtx.fillText('SUBTOTAL:                 166.00', 50, 360);
    rCtx.fillText('TAX (8%):                  13.28', 50, 390);
    rCtx.fillText('TIP (20%):                 33.20', 50, 420);
    rCtx.font = 'bold 20px monospace';
    rCtx.fillText('TOTAL:                   $212.48', 50, 470);
    rCtx.font = '14px monospace';
    rCtx.fillText('AUTH CODE: 849204 | VISA ****4921', 50, 520);
    rCtx.textAlign = 'center';
    rCtx.fillText('Thank You for Dining With Us!', 250, 580);
    const restUrl = restCanvas.toDataURL('image/jpeg', 0.9);

    // Sample 3: Starbucks Coffee & Breakfast
    const starCanvas = document.createElement('canvas');
    starCanvas.width = 440;
    starCanvas.height = 560;
    const sCtx = starCanvas.getContext('2d');
    sCtx.fillStyle = '#ffffff';
    sCtx.fillRect(0, 0, 440, 560);
    sCtx.fillStyle = '#006241'; // Starbucks green
    sCtx.fillRect(0, 0, 440, 70);
    sCtx.fillStyle = '#ffffff';
    sCtx.font = 'bold 28px sans-serif';
    sCtx.textAlign = 'center';
    sCtx.fillText('STARBUCKS', 220, 48);
    sCtx.fillStyle = '#1e293b';
    sCtx.textAlign = 'left';
    sCtx.font = '16px monospace';
    sCtx.fillText('Store #14892 - Terminal B', 40, 110);
    sCtx.fillText('Date: 2026-11-11  07:34 AM', 40, 135);
    sCtx.fillText('================================', 40, 160);
    sCtx.fillText('1 Grande Caffe Latte       $5.65', 40, 200);
    sCtx.fillText('1 Bacon Gouda Sandwich     $5.95', 40, 235);
    sCtx.fillText('================================', 40, 275);
    sCtx.fillText('Subtotal:                 $11.60', 40, 310);
    sCtx.fillText('Tax:                       $0.93', 40, 340);
    sCtx.font = 'bold 20px monospace';
    sCtx.fillText('TOTAL:                    $12.53', 40, 385);
    const starUrl = starCanvas.toDataURL('image/jpeg', 0.9);

    // Add samples to store
    await window.store.addReceipt({
      type: 'image',
      fileName: 'Uber_Airport_Trip.jpg',
      dataUrl: uberUrl,
      thumbnailDataUrl: uberUrl,
      date: '2026-11-10',
      merchant: 'Uber',
      category: 'Transportation',
      paymentMethod: 'Corporate Visa',
      amount: 37.75,
      notes: 'Rideshare from Airport to Client Hotel'
    });

    await window.store.addReceipt({
      type: 'image',
      fileName: 'Capital_Grille_Dinner.jpg',
      dataUrl: restUrl,
      thumbnailDataUrl: restUrl,
      date: '2026-11-10',
      merchant: 'The Capital Grille',
      category: 'Meals & Entertainment',
      paymentMethod: 'Corporate Visa',
      amount: 212.48,
      notes: 'Client Dinner with Acme Corp VP'
    });

    await window.store.addReceipt({
      type: 'image',
      fileName: 'Starbucks_Airport.jpg',
      dataUrl: starUrl,
      thumbnailDataUrl: starUrl,
      date: '2026-11-11',
      merchant: 'Starbucks',
      category: 'Meals & Entertainment',
      paymentMethod: 'Corporate Visa',
      amount: 12.53,
      notes: 'Breakfast on departure'
    });

    this.showToast('Demo receipts added! Check the Ledger and PDF tab.', 'success');
  }

  showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3800);
  }

  _escape(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

// Bootstrap Application on DOM Ready
window.addEventListener('DOMContentLoaded', () => {
  window.expenseApp = new ExpenseApp();
  window.expenseApp.init();
});
