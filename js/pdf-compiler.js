/**
 * ExpenseSnap - Unified PDF Compilation Engine using pdf-lib
 * Merges receipt images and digital PDFs into a single, high-quality document.
 */

class PdfCompiler {
  constructor() {
    this.PDFLib = window.PDFLib;
  }

  /**
   * Compile all receipts in report into a single PDF Blob
   * @param {Object} report Report metadata object
   * @param {Array} receipts Array of receipt objects in desired order
   * @param {Object} options Compilation options (layout, addCover, etc.)
   */
  async compileReportPdf(report, receipts, options = {}) {
    if (!this.PDFLib) {
      this.PDFLib = window.PDFLib;
    }
    const { PDFDocument, rgb, StandardFonts } = this.PDFLib;

    const pdfDoc = await PDFDocument.create();
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const layout = options.layout || report.pdfSettings?.layout || 'full'; // 'full', 'two_up', 'grid'
    const addCover = options.addCover !== undefined ? options.addCover : (report.pdfSettings?.addCover !== false);

    // Standard US Letter dimensions (8.5 x 11 inches at 72 dpi)
    const pageWidth = 612;
    const pageHeight = 792;
    const margin = 40;

    // 1. Generate Cover Summary Sheet if requested
    if (addCover) {
      await this._generateCoverPage(pdfDoc, report, receipts, {
        fontRegular,
        fontBold,
        pageWidth,
        pageHeight,
        margin
      });
    }

    // 2. Add Receipts according to selected layout
    if (layout === 'full') {
      await this._addReceiptsFullPage(pdfDoc, receipts, {
        fontRegular,
        fontBold,
        pageWidth,
        pageHeight,
        margin
      });
    } else if (layout === 'two_up') {
      await this._addReceiptsTwoUp(pdfDoc, receipts, {
        fontRegular,
        fontBold,
        pageWidth,
        pageHeight,
        margin
      });
    } else if (layout === 'grid') {
      await this._addReceiptsGrid(pdfDoc, receipts, {
        fontRegular,
        fontBold,
        pageWidth,
        pageHeight,
        margin
      });
    }

    // 3. Add Page Numbers across all pages
    const totalPages = pdfDoc.getPageCount();
    for (let i = 0; i < totalPages; i++) {
      const page = pdfDoc.getPage(i);
      const pageNumText = `Page ${i + 1} of ${totalPages}`;
      const textWidth = fontRegular.widthOfTextAtSize(pageNumText, 9);
      page.drawText(pageNumText, {
        x: pageWidth - margin - textWidth,
        y: 20,
        size: 9,
        font: fontRegular,
        color: rgb(0.4, 0.45, 0.5)
      });
      // App branding in bottom left
      page.drawText(`ExpenseSnap Report: ${report.title || 'Expenses'}`, {
        x: margin,
        y: 20,
        size: 8,
        font: fontRegular,
        color: rgb(0.5, 0.55, 0.6)
      });
    }

    // Return final PDF bytes
    const pdfBytes = await pdfDoc.save();
    return new Blob([pdfBytes], { type: 'application/pdf' });
  }

  /**
   * Cover / Expense Summary Sheet
   */
  async _generateCoverPage(pdfDoc, report, receipts, ctx) {
    const { PDFDocument, rgb } = this.PDFLib;
    const { fontRegular, fontBold, pageWidth, pageHeight, margin } = ctx;

    const page = pdfDoc.addPage([pageWidth, pageHeight]);

    // Top Header Banner
    page.drawRectangle({
      x: margin,
      y: pageHeight - margin - 60,
      width: pageWidth - (margin * 2),
      height: 60,
      color: rgb(0.31, 0.27, 0.90) // Primary Indigo
    });

    page.drawText('EXPENSE REPORT SUMMARY', {
      x: margin + 20,
      y: pageHeight - margin - 38,
      size: 18,
      font: fontBold,
      color: rgb(1, 1, 1)
    });

    // Submitter and Report Metadata
    const metaY = pageHeight - margin - 90;
    page.drawText(`Report Title:`, { x: margin, y: metaY, size: 10, font: fontBold, color: rgb(0.2, 0.2, 0.2) });
    page.drawText(`${report.title || 'Business Expenses'}`, { x: margin + 80, y: metaY, size: 10, font: fontRegular, color: rgb(0.1, 0.1, 0.1) });

    page.drawText(`Submitter:`, { x: margin, y: metaY - 18, size: 10, font: fontBold, color: rgb(0.2, 0.2, 0.2) });
    page.drawText(`${report.submitterName || 'Employee'}`, { x: margin + 80, y: metaY - 18, size: 10, font: fontRegular, color: rgb(0.1, 0.1, 0.1) });

    page.drawText(`Department:`, { x: margin, y: metaY - 36, size: 10, font: fontBold, color: rgb(0.2, 0.2, 0.2) });
    page.drawText(`${report.department || '—'}`, { x: margin + 80, y: metaY - 36, size: 10, font: fontRegular, color: rgb(0.1, 0.1, 0.1) });

    page.drawText(`Date Generated:`, { x: pageWidth - margin - 180, y: metaY, size: 10, font: fontBold, color: rgb(0.2, 0.2, 0.2) });
    page.drawText(`${new Date().toISOString().split('T')[0]}`, { x: pageWidth - margin - 85, y: metaY, size: 10, font: fontRegular, color: rgb(0.1, 0.1, 0.1) });

    page.drawText(`Total Receipts:`, { x: pageWidth - margin - 180, y: metaY - 18, size: 10, font: fontBold, color: rgb(0.2, 0.2, 0.2) });
    page.drawText(`${receipts.length}`, { x: pageWidth - margin - 85, y: metaY - 18, size: 10, font: fontRegular, color: rgb(0.1, 0.1, 0.1) });

    // Table Header (shifted down so the Department line has room)
    let tableY = metaY - 68;
    const colX = {
      item: margin,
      date: margin + 40,
      merchant: margin + 120,
      category: margin + 250,
      payment: margin + 370,
      amount: pageWidth - margin - 60
    };

    // Header Background
    page.drawRectangle({
      x: margin,
      y: tableY - 6,
      width: pageWidth - (margin * 2),
      height: 22,
      color: rgb(0.93, 0.95, 0.98)
    });

    page.drawText('#', { x: colX.item + 5, y: tableY, size: 9, font: fontBold, color: rgb(0.3, 0.35, 0.4) });
    page.drawText('Date', { x: colX.date, y: tableY, size: 9, font: fontBold, color: rgb(0.3, 0.35, 0.4) });
    page.drawText('Merchant / Vendor', { x: colX.merchant, y: tableY, size: 9, font: fontBold, color: rgb(0.3, 0.35, 0.4) });
    page.drawText('Category', { x: colX.category, y: tableY, size: 9, font: fontBold, color: rgb(0.3, 0.35, 0.4) });
    page.drawText('Payment', { x: colX.payment, y: tableY, size: 9, font: fontBold, color: rgb(0.3, 0.35, 0.4) });
    page.drawText('Amount', { x: colX.amount, y: tableY, size: 9, font: fontBold, color: rgb(0.3, 0.35, 0.4) });

    let grandTotal = 0;
    tableY -= 20;

    // Render Table Rows (up to 20 per cover page; if more, rows fit compactly)
    receipts.forEach((r, idx) => {
      const amount = parseFloat(r.amount) || 0;
      grandTotal += amount;

      if (tableY > 120) {
        // Alternating row background
        if (idx % 2 === 1) {
          page.drawRectangle({
            x: margin,
            y: tableY - 4,
            width: pageWidth - (margin * 2),
            height: 18,
            color: rgb(0.98, 0.99, 1.0)
          });
        }

        page.drawText(`${idx + 1}`, { x: colX.item + 5, y: tableY, size: 8.5, font: fontBold, color: rgb(0.3, 0.3, 0.8) });
        page.drawText(`${r.date || '-'}`, { x: colX.date, y: tableY, size: 8.5, font: fontRegular, color: rgb(0.2, 0.2, 0.2) });
        
        const merchantText = this._truncateText(r.merchant || 'Receipt', fontRegular, 8.5, 120);
        page.drawText(merchantText, { x: colX.merchant, y: tableY, size: 8.5, font: fontBold, color: rgb(0.1, 0.1, 0.1) });

        const catText = this._truncateText(this._displayCategory(r), fontRegular, 8.5, 110);
        page.drawText(catText, { x: colX.category, y: tableY, size: 8.5, font: fontRegular, color: rgb(0.3, 0.3, 0.3) });

        const payText = this._truncateText(this._displayPayment(r), fontRegular, 8.5, 90);
        page.drawText(payText, { x: colX.payment, y: tableY, size: 8.5, font: fontRegular, color: rgb(0.4, 0.4, 0.4) });

        const amountStr = `$${amount.toFixed(2)}`;
        page.drawText(amountStr, { x: colX.amount, y: tableY, size: 8.5, font: fontBold, color: rgb(0.02, 0.55, 0.35) });

        tableY -= 18;
      }
    });

    // Divider Line
    page.drawLine({
      start: { x: margin, y: tableY },
      end: { x: pageWidth - margin, y: tableY },
      thickness: 1.5,
      color: rgb(0.8, 0.85, 0.9)
    });

    // Grand Total Banner
    tableY -= 28;
    page.drawRectangle({
      x: pageWidth - margin - 220,
      y: tableY - 8,
      width: 220,
      height: 32,
      color: rgb(0.95, 0.98, 0.95),
      borderColor: rgb(0.06, 0.72, 0.50),
      borderWidth: 1.5
    });

    page.drawText('GRAND TOTAL:', {
      x: pageWidth - margin - 205,
      y: tableY + 2,
      size: 11,
      font: fontBold,
      color: rgb(0.1, 0.1, 0.1)
    });

    const totalStr = `$${grandTotal.toFixed(2)}`;
    page.drawText(totalStr, {
      x: pageWidth - margin - 85,
      y: tableY + 2,
      size: 13,
      font: fontBold,
      color: rgb(0.02, 0.55, 0.35)
    });

    // Note to Accounting / Reviewer
    page.drawText('NOTE: All original receipts are sequentially organized on the following pages matching item numbers above.', {
      x: margin,
      y: 60,
      size: 8.5,
      font: fontRegular,
      color: rgb(0.4, 0.45, 0.5)
    });
  }

  /**
   * Layout Mode 1: Full Page per Receipt (preserves vector PDF for Uber receipts!)
   */
  async _addReceiptsFullPage(pdfDoc, receipts, ctx) {
    const { PDFDocument, rgb } = this.PDFLib;
    const { fontRegular, fontBold, pageWidth, pageHeight, margin } = ctx;

    for (let i = 0; i < receipts.length; i++) {
      const r = receipts[i];
      const itemNum = i + 1;

      if (r.type === 'pdf' && r.rawArrayBuffer) {
        // Embed digital PDF natively (keeps vector text and sharp graphics)
        try {
          const srcPdf = await PDFDocument.load(r.rawArrayBuffer);
          const copiedPages = await pdfDoc.copyPages(srcPdf, srcPdf.getPageIndices());
          
          for (const page of copiedPages) {
            pdfDoc.addPage(page);
            const { width, height } = page.getSize();
            // Stamp metadata banner at top
            page.drawRectangle({
              x: 0,
              y: height - 32,
              width: width,
              height: 32,
              color: rgb(0.15, 0.20, 0.30)
            });
            page.drawText(`ITEM #${itemNum}: ${r.merchant} | Date: ${r.date} | Amount: $${(parseFloat(r.amount) || 0).toFixed(2)} [${this._displayCategory(r)}]`, {
              x: 20,
              y: height - 20,
              size: 9.5,
              font: fontBold,
              color: rgb(1, 1, 1)
            });
          }
          continue;
        } catch (err) {
          console.warn('Direct PDF embedding fallback to image:', err);
        }
      }

      // Image receipt (or PDF fallback)
      const page = pdfDoc.addPage([pageWidth, pageHeight]);

      // Top Item Header Banner
      page.drawRectangle({
        x: margin,
        y: pageHeight - margin - 34,
        width: pageWidth - (margin * 2),
        height: 34,
        color: rgb(0.95, 0.96, 0.98),
        borderColor: rgb(0.85, 0.88, 0.92),
        borderWidth: 1
      });

      page.drawText(`ITEM #${itemNum}: ${r.merchant}`, {
        x: margin + 14,
        y: pageHeight - margin - 22,
        size: 11,
        font: fontBold,
        color: rgb(0.1, 0.1, 0.1)
      });

      page.drawText(`Date: ${r.date} | Cat: ${this._displayCategory(r)} | Amount: $${(parseFloat(r.amount) || 0).toFixed(2)}`, {
        x: margin + 220,
        y: pageHeight - margin - 22,
        size: 9.5,
        font: fontRegular,
        color: rgb(0.3, 0.35, 0.4)
      });

      // Embed Image
      if (r.dataUrl) {
        try {
          const imgBytes = await this._dataUrlToBytes(r.dataUrl);
          const image = r.dataUrl.startsWith('data:image/png')
            ? await pdfDoc.embedPng(imgBytes)
            : await pdfDoc.embedJpg(imgBytes);

          const maxImgWidth = pageWidth - (margin * 2);
          const maxImgHeight = pageHeight - (margin * 2) - 80;

          const imgDims = this._fitDimensions(image.width, image.height, maxImgWidth, maxImgHeight);

          // Center the image
          const imgX = margin + (maxImgWidth - imgDims.width) / 2;
          const imgY = margin + 40 + (maxImgHeight - imgDims.height) / 2;

          page.drawImage(image, {
            x: imgX,
            y: imgY,
            width: imgDims.width,
            height: imgDims.height
          });
        } catch (err) {
          console.error('Error embedding image into PDF:', err);
        }
      }
    }
  }

  /**
   * Layout Mode 2: Two Receipts per Page (Stacked top and bottom)
   */
  async _addReceiptsTwoUp(pdfDoc, receipts, ctx) {
    const { rgb } = this.PDFLib;
    const { fontRegular, fontBold, pageWidth, pageHeight, margin } = ctx;

    const slotHeight = (pageHeight - (margin * 2) - 30) / 2;

    for (let i = 0; i < receipts.length; i += 2) {
      const page = pdfDoc.addPage([pageWidth, pageHeight]);

      for (let slot = 0; slot < 2; slot++) {
        const idx = i + slot;
        if (idx >= receipts.length) break;

        const r = receipts[idx];
        const itemNum = idx + 1;
        const slotY = slot === 0
          ? pageHeight - margin - slotHeight
          : margin + 30;

        // Slot Border Card
        page.drawRectangle({
          x: margin,
          y: slotY,
          width: pageWidth - (margin * 2),
          height: slotHeight,
          color: rgb(0.99, 1, 1),
          borderColor: rgb(0.85, 0.88, 0.92),
          borderWidth: 1
        });

        // Header bar inside card
        page.drawRectangle({
          x: margin,
          y: slotY + slotHeight - 26,
          width: pageWidth - (margin * 2),
          height: 26,
          color: rgb(0.93, 0.95, 0.98)
        });

        page.drawText(`ITEM #${itemNum}: ${r.merchant}`, {
          x: margin + 10,
          y: slotY + slotHeight - 17,
          size: 9.5,
          font: fontBold,
          color: rgb(0.1, 0.1, 0.1)
        });

        page.drawText(`${r.date} | $${(parseFloat(r.amount) || 0).toFixed(2)} (${this._displayCategory(r)})`, {
          x: pageWidth - margin - 190,
          y: slotY + slotHeight - 17,
          size: 9,
          font: fontRegular,
          color: rgb(0.2, 0.4, 0.3)
        });

        // Draw image inside slot
        if (r.dataUrl) {
          try {
            const imgBytes = await this._dataUrlToBytes(r.dataUrl);
            const image = r.dataUrl.startsWith('data:image/png')
              ? await pdfDoc.embedPng(imgBytes)
              : await pdfDoc.embedJpg(imgBytes);

            const maxSlotW = pageWidth - (margin * 2) - 20;
            const maxSlotH = slotHeight - 40;
            const dims = this._fitDimensions(image.width, image.height, maxSlotW, maxSlotH);

            const x = margin + 10 + (maxSlotW - dims.width) / 2;
            const y = slotY + 8 + (maxSlotH - dims.height) / 2;

            page.drawImage(image, { x, y, width: dims.width, height: dims.height });
          } catch (e) {
            console.error('Error embedding two-up image:', e);
          }
        }
      }
    }
  }

  /**
   * Layout Mode 3: Compact Grid (4 receipts per page)
   */
  async _addReceiptsGrid(pdfDoc, receipts, ctx) {
    const { rgb } = this.PDFLib;
    const { fontRegular, fontBold, pageWidth, pageHeight, margin } = ctx;

    const cellW = (pageWidth - (margin * 2) - 20) / 2;
    const cellH = (pageHeight - (margin * 2) - 50) / 2;

    for (let i = 0; i < receipts.length; i += 4) {
      const page = pdfDoc.addPage([pageWidth, pageHeight]);

      for (let cell = 0; cell < 4; cell++) {
        const idx = i + cell;
        if (idx >= receipts.length) break;

        const r = receipts[idx];
        const itemNum = idx + 1;

        const col = cell % 2;
        const row = Math.floor(cell / 2);

        const x = margin + col * (cellW + 20);
        const y = pageHeight - margin - ((row + 1) * (cellH + 15));

        page.drawRectangle({
          x,
          y,
          width: cellW,
          height: cellH,
          borderColor: rgb(0.85, 0.88, 0.92),
          borderWidth: 1
        });

        page.drawText(`#${itemNum} ${r.merchant} - $${(parseFloat(r.amount) || 0).toFixed(2)}`, {
          x: x + 6,
          y: y + cellH - 16,
          size: 8,
          font: fontBold,
          color: rgb(0.1, 0.1, 0.1)
        });

        if (r.dataUrl) {
          try {
            const imgBytes = await this._dataUrlToBytes(r.dataUrl);
            const image = r.dataUrl.startsWith('data:image/png')
              ? await pdfDoc.embedPng(imgBytes)
              : await pdfDoc.embedJpg(imgBytes);

            const dims = this._fitDimensions(image.width, image.height, cellW - 12, cellH - 26);
            const imgX = x + 6 + (cellW - 12 - dims.width) / 2;
            const imgY = y + 5 + (cellH - 26 - dims.height) / 2;

            page.drawImage(image, { x: imgX, y: imgY, width: dims.width, height: dims.height });
          } catch (e) {
            console.error('Error embedding grid image:', e);
          }
        }
      }
    }
  }

  _fitDimensions(origW, origH, maxW, maxH) {
    const scale = Math.min(maxW / origW, maxH / origH);
    return {
      width: origW * scale,
      height: origH * scale
    };
  }

  _displayCategory(receipt) {
    if (window.expenseLabels && window.expenseLabels.displayCategory) {
      return window.expenseLabels.displayCategory(receipt.category);
    }
    return receipt.category || 'General';
  }

  _displayPayment(receipt) {
    if (window.expenseLabels && window.expenseLabels.displayPayment) {
      return window.expenseLabels.displayPayment(receipt.paymentMethod);
    }
    return receipt.paymentMethod || 'Card';
  }

  _truncateText(text, font, size, maxWidth) {
    let t = text || '';
    if (font.widthOfTextAtSize(t, size) <= maxWidth) return t;
    while (t.length > 3 && font.widthOfTextAtSize(t + '...', size) > maxWidth) {
      t = t.slice(0, -1);
    }
    return t + '...';
  }

  async _dataUrlToBytes(dataUrl) {
    const res = await fetch(dataUrl);
    return new Uint8Array(await res.arrayBuffer());
  }
}

window.pdfCompiler = new PdfCompiler();
