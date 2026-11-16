/**
 * ExpenseSnap - Receipt Processing, PDF parsing, and Image Enhancement Engine
 */

class ReceiptManager {
  constructor() {
    // Configure PDF.js worker
    if (window.pdfjsLib) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.js';
    }
  }

  /**
   * Process a file (image or PDF) from input or dropzone
   */
  async processFile(file) {
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    
    if (isPdf) {
      return this.processPdfFile(file);
    } else {
      return this.processImageFile(file);
    }
  }

  /**
   * Process an image receipt (JPEG, PNG, HEIC, etc.)
   */
  async processImageFile(file) {
    const rawDataUrl = await this._fileToDataUrl(file);
    
    // Normalize and downscale image if necessary to prevent massive memory usage
    const optimized = await this.optimizeImage(rawDataUrl, 0, false);

    // Extract quick smart defaults from file name if possible
    const smartDefaults = this._inferDefaultsFromFileName(file.name);

    return {
      type: 'image',
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type || 'image/jpeg',
      dataUrl: optimized.dataUrl,
      thumbnailDataUrl: optimized.thumbnailUrl,
      pageCount: 1,
      rotation: 0,
      enhanceContrast: false,
      date: smartDefaults.date || new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().split('T')[0],
      merchant: smartDefaults.merchant || 'Receipt',
      category: smartDefaults.category || 'Meals',
      paymentMethod: 'Corporate Card',
      amount: 0.0,
      notes: ''
    };
  }

  /**
   * Process a digital PDF receipt (e.g. Uber, Lyft, Airline, Hotel receipt)
   */
  async processPdfFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    
    // Render first page as thumbnail using PDF.js
    const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
    const pageCount = pdf.numPages;

    const page1 = await pdf.getPage(1);
    const viewport = page1.getViewport({ scale: 1.5 });

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page1.render({
      canvasContext: ctx,
      viewport: viewport
    }).promise;

    const thumbnailCanvas = document.createElement('canvas');
    const thumbCtx = thumbnailCanvas.getContext('2d');
    const thumbScale = 300 / Math.max(viewport.width, viewport.height);
    thumbnailCanvas.width = viewport.width * thumbScale;
    thumbnailCanvas.height = viewport.height * thumbScale;
    thumbCtx.drawImage(canvas, 0, 0, thumbnailCanvas.width, thumbnailCanvas.height);

    const thumbnailUrl = thumbnailCanvas.toDataURL('image/jpeg', 0.85);
    const previewDataUrl = canvas.toDataURL('image/jpeg', 0.9);

    const smartDefaults = this._inferDefaultsFromFileName(file.name);

    return {
      type: 'pdf',
      fileName: file.name,
      fileSize: file.size,
      mimeType: 'application/pdf',
      rawArrayBuffer: arrayBuffer,
      dataUrl: previewDataUrl, // Page 1 raster preview
      thumbnailDataUrl: thumbnailUrl,
      pageCount: pageCount,
      rotation: 0,
      enhanceContrast: false,
      date: smartDefaults.date || new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().split('T')[0],
      merchant: smartDefaults.merchant || (file.name.toLowerCase().includes('uber') ? 'Uber' : 'PDF Receipt'),
      category: file.name.toLowerCase().includes('uber') ? 'Transportation' : 'Lodging',
      paymentMethod: 'Corporate Card',
      amount: 0.0,
      notes: `Digital PDF (${pageCount} page${pageCount > 1 ? 's' : ''})`
    };
  }

  /**
   * Rotate and enhance contrast on an image
   */
  async optimizeImage(dataUrl, rotation = 0, enhanceContrast = false, maxDimension = 2000) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const isRotated90 = rotation === 90 || rotation === 270;
        let origWidth = img.width;
        let origHeight = img.height;

        // Downscale calculations
        let scale = 1;
        if (Math.max(origWidth, origHeight) > maxDimension) {
          scale = maxDimension / Math.max(origWidth, origHeight);
        }

        const width = Math.round(origWidth * scale);
        const height = Math.round(origHeight * scale);

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        if (isRotated90) {
          canvas.width = height;
          canvas.height = width;
        } else {
          canvas.width = width;
          canvas.height = height;
        }

        // Apply rotation transform
        ctx.save();
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.drawImage(img, -width / 2, -height / 2, width, height);
        ctx.restore();

        // Apply contrast & sharpness enhancement for faded thermal receipts
        if (enhanceContrast) {
          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const d = imgData.data;
          const contrast = 1.45; // Increase contrast
          const brightness = 8;  // Slight brightness boost
          const intercept = 128 * (1 - contrast);

          for (let i = 0; i < d.length; i += 4) {
            // Apply contrast to R, G, B
            d[i] = Math.min(255, Math.max(0, d[i] * contrast + intercept + brightness));
            d[i + 1] = Math.min(255, Math.max(0, d[i + 1] * contrast + intercept + brightness));
            d[i + 2] = Math.min(255, Math.max(0, d[i + 2] * contrast + intercept + brightness));
          }
          ctx.putImageData(imgData, 0, 0);
        }

        const finalDataUrl = canvas.toDataURL('image/jpeg', 0.88);

        // Generate small thumbnail for card view
        const thumbCanvas = document.createElement('canvas');
        const thumbCtx = thumbCanvas.getContext('2d');
        const thumbScale = 320 / Math.max(canvas.width, canvas.height);
        thumbCanvas.width = canvas.width * thumbScale;
        thumbCanvas.height = canvas.height * thumbScale;
        thumbCtx.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
        const thumbnailUrl = thumbCanvas.toDataURL('image/jpeg', 0.8);

        resolve({
          dataUrl: finalDataUrl,
          thumbnailUrl: thumbnailUrl,
          width: canvas.width,
          height: canvas.height
        });
      };
      img.src = dataUrl;
    });
  }

  _fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = (e) => reject(e);
      reader.readAsDataURL(file);
    });
  }

  _inferDefaultsFromFileName(name) {
    const clean = name.replace(/[-_]/g, ' ').toLowerCase();
    let merchant = '';
    let category = 'Meals';
    let date = '';

    if (clean.includes('uber')) {
      merchant = 'Uber';
      category = 'Transportation';
    } else if (clean.includes('lyft')) {
      merchant = 'Lyft';
      category = 'Transportation';
    } else if (clean.includes('delta') || clean.includes('united') || clean.includes('flight') || clean.includes('airline')) {
      merchant = 'Airline';
      category = 'Lodging';
    } else if (clean.includes('marriott') || clean.includes('hilton') || clean.includes('hotel') || clean.includes('airbnb')) {
      merchant = 'Hotel';
      category = 'Lodging';
    } else if (clean.includes('starbucks') || clean.includes('coffee')) {
      merchant = 'Starbucks';
      category = 'Meals';
    } else {
      // Capitalize first word of file as fallback
      const parts = name.split(/[-_.\s]/);
      if (parts[0] && isNaN(parts[0])) {
        merchant = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
      }
    }

    // Try to extract date pattern YYYY-MM-DD or YYYYMMDD
    const dateMatch = name.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})/);
    if (dateMatch) {
      date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
    }

    return { merchant, category, date };
  }
}

window.receiptManager = new ReceiptManager();
