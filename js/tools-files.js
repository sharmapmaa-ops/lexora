/* tools-files.js — Other Services: tools that take uploaded files.
 *
 * All of these register with ServiceRunner, so they get the same
 * Translation-style shell (upload card, file table, activity log, Start).
 * Everything runs in the browser - pdf.js reads PDFs, pdf-lib writes them,
 * SheetJS reads spreadsheets, canvas handles images.
 */
(function () {
  'use strict';

  function need(lib, what) {
    if (typeof lib === 'undefined') throw new Error(what + ' failed to load - please refresh the page.');
  }
  const stem = (n) => String(n || 'file').replace(/\.[^.]+$/, '');
  const BACK = "FreeServices.open('other-services')";

  function readImage(file) {
    return new Promise(function (res, rej) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); res(img); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('That image could not be read.')); };
      img.src = url;
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (res) { canvas.toBlob(res, type, quality); });
  }

  // ══════════════════════════════════════════════════════════════════
  // SIZE PHOTO  (resize to exact dimensions / preset)
  // ══════════════════════════════════════════════════════════════════
  // Common ID-photo and profile sizes, in pixels at 300 DPI where the
  // source is specified in mm (passport photos etc).
  const PHOTO_PRESETS = {
    'custom':      { w: 0,    h: 0,    label: 'Custom (enter below)' },
    'passport':    { w: 413,  h: 531,  label: 'Passport 35x45mm (413x531)' },
    'visa':        { w: 600,  h: 600,  label: 'US Visa 2x2in (600x600)' },
    'indian-pan':  { w: 413,  h: 531,  label: 'PAN / Aadhaar (413x531)' },
    'profile':     { w: 400,  h: 400,  label: 'Profile picture (400x400)' },
    'hd':          { w: 1920, h: 1080, label: 'HD 1920x1080' },
    'instagram':   { w: 1080, h: 1080, label: 'Square 1080x1080' }
  };

  ServiceRunner.register({
    id: 'size-photo',
    title: 'Size Photo',
    icon: '🖼️',
    accept: 'image/*',
    backTo: BACK,
    browseHint: 'or click to browse (JPG / PNG / WEBP)',
    description: 'Resize a photo to an exact size - pick a preset or type your own dimensions.',
    setupHtml: function () {
      return `
        <div class="setup-group">
          <label>Preset</label>
          <select id="tSpPreset" onchange="ToolsFiles.onPreset()" style="width:100%;">
            ${Object.keys(PHOTO_PRESETS).map(function (k) {
              return `<option value="${k}">${PHOTO_PRESETS[k].label}</option>`;
            }).join('')}
          </select>
        </div>
        <div style="display:flex;gap:12px;margin-top:10px;">
          <div class="setup-group" style="flex:1;">
            <label>Width (px)</label>
            <input type="number" id="tSpW" value="413" min="1" max="10000" style="width:100%;" />
          </div>
          <div class="setup-group" style="flex:1;">
            <label>Height (px)</label>
            <input type="number" id="tSpH" value="531" min="1" max="10000" style="width:100%;" />
          </div>
        </div>
        <div class="setup-group" style="margin-top:10px;">
          <label>Fit</label>
          <select id="tSpFit" style="width:100%;">
            <option value="cover">Cover - fill the frame, crop the overflow</option>
            <option value="contain">Contain - fit inside, pad with white</option>
            <option value="stretch">Stretch - ignore aspect ratio</option>
          </select>
        </div>`;
    },
    process: async function (files, ctx, label) {
      const f = files[0];
      const w = Math.max(1, parseInt((document.getElementById('tSpW') || {}).value, 10) || 413);
      const h = Math.max(1, parseInt((document.getElementById('tSpH') || {}).value, 10) || 531);
      const fit = (document.getElementById('tSpFit') || {}).value || 'cover';

      const img = await readImage(f);
      ctx.log(`${label} > Source = ${img.naturalWidth}x${img.naturalHeight}`, 'Info');

      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const g = canvas.getContext('2d');
      // Pad with white first so "contain" doesn't leave transparent edges
      // that turn black when saved as JPEG.
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, w, h);

      const sw = img.naturalWidth, sh = img.naturalHeight;
      if (fit === 'stretch') {
        g.drawImage(img, 0, 0, w, h);
      } else {
        const scale = fit === 'cover' ? Math.max(w / sw, h / sh) : Math.min(w / sw, h / sh);
        const dw = sw * scale, dh = sh * scale;
        g.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);   // centred
      }

      const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
      ctx.download(blob, `${stem(f.name)}_${w}x${h}.jpg`);
      ctx.log(`${label} > Generate Output > ${stem(f.name)}_${w}x${h}.jpg (${(blob.size / 1024).toFixed(0)} KB)`, 'Success');
    }
  });

  function onPreset() {
    const p = PHOTO_PRESETS[(document.getElementById('tSpPreset') || {}).value];
    if (!p || !p.w) return;
    const w = document.getElementById('tSpW'), h = document.getElementById('tSpH');
    if (w) w.value = p.w;
    if (h) h.value = p.h;
  }

  // ══════════════════════════════════════════════════════════════════
  // IMAGE COMPRESSOR
  // ══════════════════════════════════════════════════════════════════
  ServiceRunner.register({
    id: 'image-compressor',
    title: 'Image Compressor',
    icon: '🗜️',
    accept: 'image/*',
    backTo: BACK,
    browseHint: 'or click to browse (JPG / PNG / WEBP)',
    description: 'Shrink image file size, optionally capping the largest dimension.',
    setupHtml: function () {
      return `
        <div class="setup-group">
          <label>Quality</label>
          <select id="tIcQ" style="width:100%;">
            <option value="0.85">High (85%) - barely visible change</option>
            <option value="0.7" selected>Balanced (70%)</option>
            <option value="0.5">Small (50%)</option>
            <option value="0.35">Smallest (35%) - visible softening</option>
          </select>
        </div>
        <div class="setup-group" style="margin-top:10px;">
          <label>Max dimension (px, 0 = keep original)</label>
          <input type="number" id="tIcMax" value="1920" min="0" max="10000" style="width:100%;" />
        </div>`;
    },
    process: async function (files, ctx, label) {
      const f = files[0];
      const q = parseFloat((document.getElementById('tIcQ') || {}).value) || 0.7;
      const maxDim = parseInt((document.getElementById('tIcMax') || {}).value, 10) || 0;

      const img = await readImage(f);
      let w = img.naturalWidth, h = img.naturalHeight;
      if (maxDim > 0 && Math.max(w, h) > maxDim) {
        const s = maxDim / Math.max(w, h);
        w = Math.round(w * s); h = Math.round(h * s);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const g = canvas.getContext('2d');
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
      g.drawImage(img, 0, 0, w, h);

      const blob = await canvasToBlob(canvas, 'image/jpeg', q);
      const saved = f.size > 0 ? Math.round((1 - blob.size / f.size) * 100) : 0;
      ctx.download(blob, `${stem(f.name)}_compressed.jpg`);
      ctx.log(`${label} > ${(f.size / 1024).toFixed(0)} KB -> ${(blob.size / 1024).toFixed(0)} KB (${saved > 0 ? saved + '% smaller' : 'no reduction'})`, 'Info');
      ctx.log(`${label} > Generate Output > ${stem(f.name)}_compressed.jpg`, 'Success');
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // IMAGE CROPPER  (aspect-ratio crop, centred)
  // ══════════════════════════════════════════════════════════════════
  ServiceRunner.register({
    id: 'image-cropper',
    title: 'Image Cropper',
    icon: '✂️',
    accept: 'image/*',
    backTo: BACK,
    browseHint: 'or click to browse (JPG / PNG / WEBP)',
    description: 'Crop to a fixed aspect ratio, taken from the centre of the image.',
    setupHtml: function () {
      return `
        <div class="setup-group">
          <label>Aspect ratio</label>
          <select id="tCrRatio" style="width:100%;">
            <option value="1:1">1:1 Square</option>
            <option value="4:3">4:3</option>
            <option value="3:2">3:2</option>
            <option value="16:9">16:9 Widescreen</option>
            <option value="3:4">3:4 Portrait</option>
            <option value="9:16">9:16 Story</option>
          </select>
        </div>`;
    },
    process: async function (files, ctx, label) {
      const f = files[0];
      const parts = ((document.getElementById('tCrRatio') || {}).value || '1:1').split(':');
      const rw = parseFloat(parts[0]) || 1, rh = parseFloat(parts[1]) || 1;

      const img = await readImage(f);
      const sw = img.naturalWidth, sh = img.naturalHeight;
      // Largest rectangle of the wanted ratio that fits inside the source.
      let cw = sw, ch = Math.round(sw * rh / rw);
      if (ch > sh) { ch = sh; cw = Math.round(sh * rw / rh); }
      const sx = Math.round((sw - cw) / 2), sy = Math.round((sh - ch) / 2);

      const canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      canvas.getContext('2d').drawImage(img, sx, sy, cw, ch, 0, 0, cw, ch);

      const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
      ctx.download(blob, `${stem(f.name)}_${rw}x${rh}.jpg`);
      ctx.log(`${label} > ${sw}x${sh} -> ${cw}x${ch}`, 'Info');
      ctx.log(`${label} > Generate Output > ${stem(f.name)}_${rw}x${rh}.jpg`, 'Success');
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // PDF COMPRESS
  // ══════════════════════════════════════════════════════════════════
  ServiceRunner.register({
    id: 'pdf-compress',
    title: 'PDF Compress',
    icon: '🗜️',
    accept: 'application/pdf',
    backTo: BACK,
    description: 'Reduce PDF file size by re-rendering each page as a compressed image.',
    setupHtml: function () {
      return `
        <div class="setup-group">
          <label>Compression</label>
          <select id="tPcQ" style="width:100%;">
            <option value="0.8|2">Light - best quality</option>
            <option value="0.6|1.5" selected>Balanced</option>
            <option value="0.45|1.2">Strong - smallest file</option>
          </select>
        </div>
        <div style="margin-top:10px;padding:8px 10px;border:1px solid #e0a800;background:#fff8e1;border-radius:6px;font-size:0.8rem;color:#7a5c00;">
          Pages are rebuilt as images, so the text in the output is no longer
          selectable or searchable. Use this for sharing, not for archiving.
        </div>`;
    },
    process: async function (files, ctx, label) {
      need(typeof pdfjsLib !== 'undefined' ? pdfjsLib : undefined, 'pdf.js');
      need(typeof PDFLib !== 'undefined' ? PDFLib : undefined, 'pdf-lib');
      const f = files[0];
      const cfg = ((document.getElementById('tPcQ') || {}).value || '0.6|1.5').split('|');
      const quality = parseFloat(cfg[0]) || 0.6, scale = parseFloat(cfg[1]) || 1.5;

      const pdf = await pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise;
      if (ctx.pages) ctx.pages(pdf.numPages);
      const out = await PDFLib.PDFDocument.create();

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
        const g = canvas.getContext('2d');
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: g, viewport: vp }).promise;
        const jpg = await canvasToBlob(canvas, 'image/jpeg', quality);
        const emb = await out.embedJpg(await jpg.arrayBuffer());
        const p = out.addPage([emb.width, emb.height]);
        p.drawImage(emb, { x: 0, y: 0, width: emb.width, height: emb.height });
        if (ctx.progress) ctx.progress((i / pdf.numPages) * 100);
      }

      const bytes = await out.save();
      const saved = f.size > 0 ? Math.round((1 - bytes.length / f.size) * 100) : 0;
      ctx.download(new Blob([bytes], { type: 'application/pdf' }), `${stem(f.name)}_compressed.pdf`);
      ctx.log(`${label} > ${(f.size / 1024).toFixed(0)} KB -> ${(bytes.length / 1024).toFixed(0)} KB (${saved > 0 ? saved + '% smaller' : 'no reduction - already compact'})`, 'Info');
      ctx.log(`${label} > Generate Output > ${stem(f.name)}_compressed.pdf`, 'Success');
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // PDF FORM FILLER
  // ══════════════════════════════════════════════════════════════════
  // Two steps: upload a PDF, press Start to LIST its form fields, then type
  // values and press Fill. A blind "upload and fill" isn't possible - the
  // field names only exist inside the file.
  let formDoc = null, formFields = [];

  ServiceRunner.register({
    id: 'pdf-form-filler',
    title: 'PDF Form Filler',
    icon: '📝',
    accept: 'application/pdf',
    backTo: BACK,
    multiple: false,
    description: 'Read a fillable PDF\'s form fields, type the values, and download the completed file.',
    setupHtml: function () {
      if (!formFields.length) {
        return `<div class="setup-group">
          <label>&nbsp;</label>
          <div style="font-size:0.84rem;color:rgba(0,0,0,0.55);">
            Upload a fillable PDF and press <b>Start</b> - its form fields will be listed here.
          </div>
        </div>`;
      }
      return `
        <div class="setup-group">
          <label>Form fields (${formFields.length})</label>
          <div style="max-height:200px;overflow-y:scroll;border:1px solid rgba(0,0,139,0.12);border-radius:6px;padding:8px;">
            ${formFields.map(function (f, i) {
              if (f.type === 'checkbox') {
                return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                  <input type="checkbox" id="tFf_${i}" style="width:auto;" ${f.value ? 'checked' : ''} />
                  <span style="font-size:0.84rem;">${f.name}</span>
                </div>`;
              }
              return `<div style="margin-bottom:8px;">
                <div style="font-size:0.78rem;color:rgba(0,0,0,0.55);">${f.name}</div>
                <input type="text" id="tFf_${i}" value="${String(f.value || '').replace(/"/g, '&quot;')}" style="width:100%;" />
              </div>`;
            }).join('')}
          </div>
          <button class="process-btn start-btn" style="margin-top:10px;" onclick="ToolsFiles.fillForm()">✍️ Fill &amp; Download</button>
        </div>`;
    },
    process: async function (files, ctx, label) {
      need(typeof PDFLib !== 'undefined' ? PDFLib : undefined, 'pdf-lib');
      const f = files[0];
      const doc = await PDFLib.PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true });
      const form = doc.getForm();
      const fields = form.getFields();
      if (!fields.length) throw new Error('This PDF has no fillable form fields.');

      formDoc = { bytes: await f.arrayBuffer(), name: f.name };
      formFields = fields.map(function (fl) {
        const type = fl.constructor.name;
        let value = '';
        let kind = 'text';
        try {
          if (type === 'PDFCheckBox') { kind = 'checkbox'; value = fl.isChecked(); }
          else if (type === 'PDFTextField') { value = fl.getText() || ''; }
          else if (type === 'PDFDropdown') { value = (fl.getSelected() || [])[0] || ''; }
          else if (type === 'PDFRadioGroup') { value = fl.getSelected() || ''; }
        } catch (e) { /* unreadable field - leave blank */ }
        return { name: fl.getName(), type: kind, value: value };
      });
      ctx.log(`${label} > Found ${formFields.length} form field(s) - fill them in the Setup card`, 'Success');
      ServiceRunner.refresh('pdf-form-filler');
    }
  });

  async function fillForm() {
    if (!formDoc) return;
    const doc = await PDFLib.PDFDocument.load(formDoc.bytes, { ignoreEncryption: true });
    const form = doc.getForm();
    let filled = 0;
    formFields.forEach(function (f, i) {
      const el = document.getElementById('tFf_' + i);
      if (!el) return;
      try {
        if (f.type === 'checkbox') {
          const box = form.getCheckBox(f.name);
          if (el.checked) box.check(); else box.uncheck();
        } else {
          form.getTextField(f.name).setText(el.value);
        }
        filled++;
      } catch (e) { /* field type we can't set - skip it rather than abort */ }
    });
    const bytes = await doc.save();
    ServiceRunner.download(new Blob([bytes], { type: 'application/pdf' }), `${stem(formDoc.name)}_filled.pdf`);
    const st = ServiceRunner.state('pdf-form-filler');
    st.log.unshift({ time: new Date().toLocaleString(), activity: `Filled ${filled} field(s) > ${stem(formDoc.name)}_filled.pdf`, status: 'Success' });
    ServiceRunner.refresh('pdf-form-filler');
  }

  // ══════════════════════════════════════════════════════════════════
  // CREATE PDF  (Excel / CSV / text -> PDF)
  // ══════════════════════════════════════════════════════════════════
  ServiceRunner.register({
    id: 'create-pdf',
    title: 'Create PDF',
    icon: '📄',
    accept: '.xlsx,.xls,.csv,.txt',
    backTo: BACK,
    browseHint: 'or click to browse (Excel / CSV / TXT)',
    description: 'Turn a spreadsheet or text file into a PDF.',
    setupHtml: function () {
      return `
        <div class="setup-group">
          <label>Page size</label>
          <select id="tCpSize" style="width:100%;">
            <option value="a4">A4 (portrait)</option>
            <option value="a4l">A4 (landscape)</option>
            <option value="letter">Letter (portrait)</option>
          </select>
        </div>
        <div style="margin-top:10px;padding:8px 10px;border:1px solid #7aa7cc;background:#eef5fb;border-radius:6px;font-size:0.8rem;color:#2c5777;">
          Word (.docx) is not supported here - its layout can't be reproduced
          faithfully in the browser. Excel, CSV and plain text convert cleanly.
        </div>`;
    },
    process: async function (files, ctx, label) {
      need(typeof PDFLib !== 'undefined' ? PDFLib : undefined, 'pdf-lib');
      const f = files[0];
      const sizeKey = (document.getElementById('tCpSize') || {}).value || 'a4';
      const PAGE = { a4: [595, 842], a4l: [842, 595], letter: [612, 792] }[sizeKey] || [595, 842];

      let rows = [];
      if (/\.(xlsx|xls)$/i.test(f.name)) {
        need(typeof XLSX !== 'undefined' ? XLSX : undefined, 'the spreadsheet library');
        const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }).map(function (r) {
          return r.map(function (c) { return String(c == null ? '' : c); });
        });
      } else {
        const text = await f.text();
        rows = text.split(/\r?\n/).map(function (line) {
          return /\.csv$/i.test(f.name) ? line.split(',') : [line];
        });
      }
      if (!rows.length) throw new Error('That file appears to be empty.');
      ctx.log(`${label} > Rows read = ${rows.length}`, 'Info');

      const doc = await PDFLib.PDFDocument.create();
      const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
      const fontSize = 9, lineH = 13, margin = 36;
      const usableW = PAGE[0] - margin * 2;
      let page = doc.addPage(PAGE);
      let y = PAGE[1] - margin;

      const colCount = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 1);
      const colW = usableW / colCount;

      for (let i = 0; i < rows.length; i++) {
        if (y < margin + lineH) { page = doc.addPage(PAGE); y = PAGE[1] - margin; }
        rows[i].forEach(function (cell, c) {
          // Trim to the column width so cells never overlap each other.
          let text = String(cell);
          const maxChars = Math.max(1, Math.floor(colW / (fontSize * 0.5)));
          if (text.length > maxChars) text = text.slice(0, maxChars - 1) + '…';
          // WinAnsi (the standard font's encoding) can't represent every
          // character - drop the ones it can't rather than throwing.
          text = text.replace(/[^\x20-\xFF]/g, '?');
          try {
            page.drawText(text, { x: margin + c * colW, y: y, size: fontSize, font: font });
          } catch (e) { /* skip an un-encodable cell */ }
        });
        y -= lineH;
        if (i % 50 === 0 && ctx.progress) ctx.progress((i / rows.length) * 100);
      }

      const bytes = await doc.save();
      ctx.download(new Blob([bytes], { type: 'application/pdf' }), `${stem(f.name)}.pdf`);
      ctx.log(`${label} > Generate Output > ${stem(f.name)}.pdf (${doc.getPageCount()} page(s))`, 'Success');
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // DATA COMPARISON  (line diff between two files)
  // ══════════════════════════════════════════════════════════════════
  ServiceRunner.register({
    id: 'data-comparison',
    title: 'Data Comparison',
    icon: '🔍',
    accept: '.txt,.csv,.json,.xml,.md,.log,application/pdf',
    backTo: BACK,
    batch: true,
    browseHint: 'or click to browse - select exactly TWO files',
    description: 'Compare two files line by line and see what was added, removed or changed.',
    process: async function (files, ctx) {
      if (files.length !== 2) throw new Error('Select exactly two files to compare.');

      async function textOf(f) {
        if (/\.pdf$/i.test(f.name)) {
          need(typeof pdfjsLib !== 'undefined' ? pdfjsLib : undefined, 'pdf.js');
          const pdf = await pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise;
          const parts = [];
          for (let p = 1; p <= pdf.numPages; p++) {
            const tc = await (await pdf.getPage(p)).getTextContent();
            parts.push(tc.items.map(function (it) { return it.str; }).join(' '));
          }
          return parts.join('\n');
        }
        return await f.text();
      }

      const a = (await textOf(files[0])).split(/\r?\n/);
      const b = (await textOf(files[1])).split(/\r?\n/);
      ctx.log(`${files[0].name}: ${a.length} line(s)`, 'Info');
      ctx.log(`${files[1].name}: ${b.length} line(s)`, 'Info');

      const diff = lineDiff(a, b);
      const added = diff.filter(function (d) { return d.t === '+'; }).length;
      const removed = diff.filter(function (d) { return d.t === '-'; }).length;
      ctx.log(`Differences > ${added} added, ${removed} removed`, added + removed ? 'Info' : 'Success');

      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const html = `<html><head><meta charset="utf-8"><title>Comparison</title>
        <style>body{font-family:Consolas,monospace;font-size:12px;}
        .a{background:#e6ffed;} .r{background:#ffeef0;} .s{color:#666;}
        div{padding:1px 6px;white-space:pre-wrap;}</style></head><body>
        <h3 style="font-family:Arial;">${esc(files[0].name)} &rarr; ${esc(files[1].name)}</h3>
        <p style="font-family:Arial;">${added} added, ${removed} removed</p>
        ${diff.map(function (d) {
          const cls = d.t === '+' ? 'a' : d.t === '-' ? 'r' : 's';
          return `<div class="${cls}">${d.t} ${esc(d.v)}</div>`;
        }).join('')}
        </body></html>`;
      ctx.download(new Blob([html], { type: 'text/html' }), 'comparison.html');
      ctx.log('Generate Output > comparison.html', 'Success');
    }
  });

  // Longest-common-subsequence diff. Falls back to a cheap "removed then
  // added" summary on very large files, because the LCS table is O(n*m) and
  // would otherwise lock the browser up on two big documents.
  function lineDiff(a, b) {
    const MAX = 2500;
    if (a.length > MAX || b.length > MAX) {
      const setB = new Set(b);
      const setA = new Set(a);
      return a.filter(function (l) { return !setB.has(l); }).map(function (v) { return { t: '-', v: v }; })
        .concat(b.filter(function (l) { return !setA.has(l); }).map(function (v) { return { t: '+', v: v }; }));
    }
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, function () { return new Uint32Array(m + 1); });
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const outRows = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { outRows.push({ t: ' ', v: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { outRows.push({ t: '-', v: a[i] }); i++; }
      else { outRows.push({ t: '+', v: b[j] }); j++; }
    }
    while (i < n) { outRows.push({ t: '-', v: a[i++] }); }
    while (j < m) { outRows.push({ t: '+', v: b[j++] }); }
    return outRows;
  }

  // ══════════════════════════════════════════════════════════════════
  // PDF TO WORD  (text extraction -> .doc)
  // ══════════════════════════════════════════════════════════════════
  ServiceRunner.register({
    id: 'pdf-to-word',
    title: 'PDF to Word',
    icon: '📃',
    accept: 'application/pdf',
    backTo: BACK,
    description: 'Pull the text out of a PDF into an editable Word document.',
    setupHtml: function () {
      return `<div style="padding:8px 10px;border:1px solid #e0a800;background:#fff8e1;border-radius:6px;font-size:0.8rem;color:#7a5c00;">
        This extracts the <b>text</b>, not the layout - columns, tables and
        images are not reproduced. For a layout-faithful conversion of a
        scanned document, use the paid <b>Translation</b> service with
        "With OCR", which rebuilds the page properly.
      </div>`;
    },
    process: async function (files, ctx, label) {
      need(typeof pdfjsLib !== 'undefined' ? pdfjsLib : undefined, 'pdf.js');
      const f = files[0];
      const pdf = await pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise;
      if (ctx.pages) ctx.pages(pdf.numPages);

      const escHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const pagesHtml = [];
      let totalChars = 0;

      for (let p = 1; p <= pdf.numPages; p++) {
        const tc = await (await pdf.getPage(p)).getTextContent();
        // Group items into lines by their y position, so the output keeps
        // line breaks instead of becoming one long paragraph.
        const lines = [];
        let lastY = null, buf = [];
        tc.items.forEach(function (it) {
          const y = Math.round(it.transform[5]);
          if (lastY !== null && Math.abs(y - lastY) > 3) { lines.push(buf.join('')); buf = []; }
          buf.push(it.str);
          lastY = y;
        });
        if (buf.length) lines.push(buf.join(''));

        const body = lines
          .map(function (l) { return l.replace(/\s+/g, ' ').trim(); })
          .filter(function (l) { return l; })
          .map(function (l) { totalChars += l.length; return `<p>${escHtml(l)}</p>`; })
          .join('');
        pagesHtml.push(body || '<p></p>');
        if (ctx.progress) ctx.progress((p / pdf.numPages) * 100);
      }

      if (!totalChars) throw new Error('No selectable text found - this looks like a scanned PDF. Use Translation with "With OCR" instead.');

      const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
        <head><meta charset="utf-8"><title>${escHtml(stem(f.name))}</title>
        <style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt;} p{margin:0 0 6pt 0;}
        .pb{page-break-before:always;}</style></head><body>
        ${pagesHtml.map(function (h, i) { return `<div${i ? ' class="pb"' : ''}>${h}</div>`; }).join('')}
        </body></html>`;

      ctx.download(new Blob(['\ufeff' + html], { type: 'application/msword' }), `${stem(f.name)}.doc`);
      ctx.log(`${label} > Text Data = ${totalChars} character(s) from ${pdf.numPages} page(s)`, 'Info');
      ctx.log(`${label} > Generate Output > ${stem(f.name)}.doc`, 'Success');
    }
  });

  window.ToolsFiles = {
    onPreset: onPreset,
    fillForm: fillForm,
    lineDiff: lineDiff
  };
})();
