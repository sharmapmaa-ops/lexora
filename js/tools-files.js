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
          <div class="setup-group" style="flex:1;">
            <label>Fit</label>
            <select id="tSpFit" style="width:100%;">
              <option value="cover">Cover - fill the frame, crop the overflow</option>
              <option value="contain">Contain - fit inside, pad with white</option>
              <option value="stretch">Stretch - ignore aspect ratio</option>
            </select>
          </div>
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
          <label>Max dimension (px)</label>
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
        return '';
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
    ServiceRunner.smartDownload('pdf-form-filler', new Blob([bytes], { type: 'application/pdf' }), `${stem(formDoc.name)}_filled.pdf`);
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
      return '';
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

  // ══════════════════════════════════════════════════════════════════
  // UNLOCK PDF
  // ══════════════════════════════════════════════════════════════════
  ServiceRunner.register({
    id: 'unlock-pdf',
    title: 'Unlock PDF',
    icon: '🔓',
    accept: 'application/pdf',
    backTo: BACK,
    description: 'Remove owner-password restrictions (printing, copying, editing) from a PDF.',
    setupHtml: function () { return ''; },
    process: async function (files, ctx, label) {
      need(typeof PDFLib !== 'undefined' ? PDFLib : undefined, 'pdf-lib');
      const f = files[0];
      // ignoreEncryption loads the PDF even with owner-password
      // restrictions in place, and re-saving it (pdf-lib doesn't carry
      // encryption/permission flags forward) produces an unrestricted
      // copy. This only removes PERMISSION restrictions - a PDF that
      // needs a password just to OPEN it needs that password entered
      // elsewhere first; there's nothing to "crack" here.
      const src = await PDFLib.PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true });
      const bytes = await src.save();
      ctx.download(new Blob([bytes], { type: 'application/pdf' }), `${stem(f.name)}_unlocked.pdf`);
      ctx.log(`${label} > Pages = ${src.getPageCount()}`, 'Info');
      ctx.log(`${label} > Generate Output > ${stem(f.name)}_unlocked.pdf`, 'Success');
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // PDF ROTATE / REORDER
  // ══════════════════════════════════════════════════════════════════
  ServiceRunner.register({
    id: 'pdf-rotate-reorder',
    title: 'PDF Rotate/Reorder',
    icon: '🔃',
    accept: 'application/pdf',
    backTo: BACK,
    multiple: false,
    description: 'Rotate pages and/or put them in a new order.',
    setupHtml: function () {
      return `
        <div class="setup-group">
          <label>Rotate every page by</label>
          <select id="tRrAngle" style="width:100%;">
            <option value="0">No rotation</option>
            <option value="90">90° clockwise</option>
            <option value="180">180°</option>
            <option value="270">270° clockwise (90° counter-clockwise)</option>
          </select>
        </div>
        <div class="setup-group" style="margin-top:10px;">
          <label>New page order (optional)</label>
          <input type="text" id="tRrOrder" placeholder="e.g. 3,1,2,4 - leave empty to keep current order" />
        </div>`;
    },
    process: async function (files, ctx, label) {
      need(typeof PDFLib !== 'undefined' ? PDFLib : undefined, 'pdf-lib');
      const angle = parseInt((document.getElementById('tRrAngle') || {}).value, 10) || 0;
      const orderSpec = ((document.getElementById('tRrOrder') || {}).value || '').trim();

      const f = files[0];
      const src = await PDFLib.PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true });
      const total = src.getPageCount();
      ctx.log(`${label} > Pages found = ${total}`, 'Info');

      // Parse "3,1,2,4" into zero-based indices, 1-indexed from the user's
      // point of view. An empty box keeps the current order - only
      // rotation gets applied in that case.
      let order = Array.from({ length: total }, function (_, i) { return i; });
      if (orderSpec) {
        const picked = orderSpec.split(',').map(function (s) { return parseInt(s.trim(), 10) - 1; });
        if (picked.some(function (n) { return isNaN(n) || n < 0 || n >= total; })) {
          throw new Error(`Page order must list numbers between 1 and ${total} (e.g. "3,1,2,4").`);
        }
        if (picked.length !== total) {
          throw new Error(`Page order must include all ${total} page(s) exactly once.`);
        }
        order = picked;
      }

      const out = await PDFLib.PDFDocument.create();
      const copied = await out.copyPages(src, order);
      copied.forEach(function (p) {
        if (angle) p.setRotation(PDFLib.degrees((p.getRotation().angle + angle) % 360));
        out.addPage(p);
      });

      const bytes = await out.save();
      ctx.download(new Blob([bytes], { type: 'application/pdf' }), `${stem(f.name)}_reordered.pdf`);
      ctx.log(`${label} > Generate Output > ${stem(f.name)}_reordered.pdf (${order.length} page(s))`, 'Success');
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // CREATE ZIP
  // ══════════════════════════════════════════════════════════════════
  ServiceRunner.register({
    id: 'create-zip',
    title: 'Create ZIP',
    icon: '🗜️',
    accept: '*',
    backTo: BACK,
    description: 'Combine any files into a single ZIP archive.',
    setupHtml: function () { return ''; },
    process: async function (files, ctx, label) {
      need(typeof JSZip !== 'undefined' ? JSZip : undefined, 'JSZip');
      const zip = new JSZip();
      for (const f of files) {
        zip.file(f.name, await f.arrayBuffer());
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      ctx.download(blob, 'archive.zip');
      ctx.log(`${label} > Generate Output > archive.zip (${files.length} file(s))`, 'Success');
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // EXCEL TO CSV
  // ══════════════════════════════════════════════════════════════════
  ServiceRunner.register({
    id: 'excel-to-csv',
    title: 'Excel to CSV',
    icon: '📊',
    accept: '.xlsx,.xls',
    backTo: BACK,
    description: 'Convert the first sheet of an Excel file into a CSV.',
    setupHtml: function () { return ''; },
    process: async function (files, ctx, label) {
      need(typeof XLSX !== 'undefined' ? XLSX : undefined, 'SheetJS');
      const f = files[0];
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const sheetName = wb.SheetNames[0];
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]);
      ctx.download(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }), `${stem(f.name)}.csv`);
      ctx.log(`${label} > Sheet = ${sheetName}`, 'Info');
      ctx.log(`${label} > Generate Output > ${stem(f.name)}.csv`, 'Success');
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // CSV TO EXCEL
  // ══════════════════════════════════════════════════════════════════
  ServiceRunner.register({
    id: 'csv-to-excel',
    title: 'CSV to Excel',
    icon: '📈',
    accept: '.csv,text/csv',
    backTo: BACK,
    description: 'Convert a CSV file into an Excel workbook.',
    setupHtml: function () { return ''; },
    process: async function (files, ctx, label) {
      need(typeof XLSX !== 'undefined' ? XLSX : undefined, 'SheetJS');
      const f = files[0];
      const text = await f.text();
      const wb = XLSX.read(text, { type: 'string' });
      const bytes = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      ctx.download(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${stem(f.name)}.xlsx`);
      ctx.log(`${label} > Generate Output > ${stem(f.name)}.xlsx`, 'Success');
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // SPLIT EXCEL (one file per sheet, delivered as a ZIP)
  // ══════════════════════════════════════════════════════════════════
  ServiceRunner.register({
    id: 'split-excel',
    title: 'Split Excel',
    icon: '✂️',
    accept: '.xlsx,.xls',
    backTo: BACK,
    multiple: false,
    description: 'Split a multi-sheet workbook into one Excel file per sheet.',
    setupHtml: function () { return ''; },
    process: async function (files, ctx, label) {
      need(typeof XLSX !== 'undefined' ? XLSX : undefined, 'SheetJS');
      need(typeof JSZip !== 'undefined' ? JSZip : undefined, 'JSZip');
      const f = files[0];
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      if (wb.SheetNames.length < 2) throw new Error('This workbook only has one sheet - nothing to split.');

      const zip = new JSZip();
      wb.SheetNames.forEach(function (name) {
        const outWb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(outWb, wb.Sheets[name], name);
        const bytes = XLSX.write(outWb, { bookType: 'xlsx', type: 'array' });
        zip.file(`${name}.xlsx`, bytes);
      });
      const blob = await zip.generateAsync({ type: 'blob' });
      ctx.download(blob, `${stem(f.name)}_split.zip`);
      ctx.log(`${label} > Sheets found = ${wb.SheetNames.length}`, 'Info');
      ctx.log(`${label} > Generate Output > ${stem(f.name)}_split.zip (${wb.SheetNames.length} file(s))`, 'Success');
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // IMAGE FORMAT CONVERTER
  // ══════════════════════════════════════════════════════════════════
  ServiceRunner.register({
    id: 'image-format-converter',
    title: 'Image Format Converter',
    icon: '🔄',
    accept: 'image/*',
    backTo: BACK,
    description: 'Convert images between JPG, PNG, and WEBP.',
    setupHtml: function () {
      return `
        <div class="setup-group">
          <label>Convert to</label>
          <select id="tIfcFormat" style="width:100%;">
            <option value="image/png">PNG</option>
            <option value="image/jpeg" selected>JPG</option>
            <option value="image/webp">WEBP</option>
          </select>
        </div>`;
    },
    process: async function (files, ctx, label) {
      const mime = (document.getElementById('tIfcFormat') || {}).value || 'image/jpeg';
      const ext = mime === 'image/png' ? 'png' : (mime === 'image/webp' ? 'webp' : 'jpg');
      const f = files[0];
      const img = await new Promise(function (resolve, reject) {
        const el = new Image();
        el.onload = function () { resolve(el); };
        el.onerror = function () { reject(new Error('Could not read that image.')); };
        el.src = URL.createObjectURL(f);
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const cctx = canvas.getContext('2d');
      // JPG has no transparency - fill white behind the image first so a
      // PNG with a transparent background doesn't turn black.
      if (mime === 'image/jpeg') { cctx.fillStyle = '#fff'; cctx.fillRect(0, 0, canvas.width, canvas.height); }
      cctx.drawImage(img, 0, 0);
      const blob = await new Promise(function (resolve) { canvas.toBlob(resolve, mime, 0.92); });
      ctx.download(blob, `${stem(f.name)}.${ext}`);
      ctx.log(`${label} > Source = ${img.naturalWidth}x${img.naturalHeight}`, 'Info');
      ctx.log(`${label} > Generate Output > ${stem(f.name)}.${ext}`, 'Success');
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // COLOR PALETTE EXTRACTOR
  // ══════════════════════════════════════════════════════════════════
  ServiceRunner.register({
    id: 'color-palette-extractor',
    title: 'Color Palette Extractor',
    icon: '🎨',
    accept: 'image/*',
    backTo: BACK,
    description: 'Pull the dominant colors out of an image as a swatch strip + hex codes.',
    setupHtml: function () {
      return `
        <div class="setup-group">
          <label>Number of colors</label>
          <select id="tCpeCount" style="width:100%;">
            <option value="5">5</option>
            <option value="6" selected>6</option>
            <option value="8">8</option>
            <option value="10">10</option>
          </select>
        </div>`;
    },
    process: async function (files, ctx, label) {
      const count = parseInt((document.getElementById('tCpeCount') || {}).value, 10) || 6;
      const f = files[0];
      const img = await new Promise(function (resolve, reject) {
        const el = new Image();
        el.onload = function () { resolve(el); };
        el.onerror = function () { reject(new Error('Could not read that image.')); };
        el.src = URL.createObjectURL(f);
      });

      // Sample down to a small canvas first - reading every pixel of a
      // full-size photo is slow and unnecessary for finding dominant
      // colors; 100x100 is plenty of signal.
      const sampleSize = 100;
      const sampleCanvas = document.createElement('canvas');
      sampleCanvas.width = sampleSize;
      sampleCanvas.height = sampleSize;
      const sctx = sampleCanvas.getContext('2d');
      sctx.drawImage(img, 0, 0, sampleSize, sampleSize);
      const data = sctx.getImageData(0, 0, sampleSize, sampleSize).data;

      // Quantize each channel into 8 buckets (0-255 -> 0-7) and count
      // which bucket combination appears most often - simple, fast, and
      // good enough to find the genuinely dominant colors rather than
      // noise from anti-aliased edges.
      const buckets = {};
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (a < 40) continue; // skip near-transparent pixels
        const r = Math.floor(data[i] / 32) * 32;
        const g = Math.floor(data[i + 1] / 32) * 32;
        const b = Math.floor(data[i + 2] / 32) * 32;
        const key = r + ',' + g + ',' + b;
        buckets[key] = (buckets[key] || 0) + 1;
      }
      const sorted = Object.keys(buckets).sort(function (a, b) { return buckets[b] - buckets[a]; });
      const top = sorted.slice(0, count).map(function (key) {
        const [r, g, b] = key.split(',').map(Number);
        return { r: r, g: g, b: b };
      });
      if (!top.length) throw new Error('Could not find any colors - is this a blank/transparent image?');

      const hex = (n) => n.toString(16).padStart(2, '0');
      const hexCodes = top.map(function (c) { return '#' + hex(c.r) + hex(c.g) + hex(c.b); });

      // Build a swatch strip image as the downloadable output.
      const swW = 120, swH = 120;
      const outCanvas = document.createElement('canvas');
      outCanvas.width = swW * top.length;
      outCanvas.height = swH + 30;
      const octx = outCanvas.getContext('2d');
      octx.fillStyle = '#fff';
      octx.fillRect(0, 0, outCanvas.width, outCanvas.height);
      top.forEach(function (c, i) {
        octx.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
        octx.fillRect(i * swW, 0, swW, swH);
        octx.fillStyle = '#111';
        octx.font = '13px monospace';
        octx.textAlign = 'center';
        octx.fillText(hexCodes[i], i * swW + swW / 2, swH + 20);
      });

      const blob = await new Promise(function (resolve) { outCanvas.toBlob(resolve, 'image/png'); });
      ctx.download(blob, `${stem(f.name)}_palette.png`);
      ctx.log(`${label} > Colors found = ${hexCodes.join(', ')}`, 'Info');
      ctx.log(`${label} > Generate Output > ${stem(f.name)}_palette.png`, 'Success');
    }
  });

  // Shared PDF page-size lookup and a simple word-wrapping text writer -
  // used by both Word to PDF (long paragraphs) and Excel to PDF (reuses
  // Create PDF's row/column table layout instead, see below).
  const PDF_PAGE_SIZES = { a4: [595, 842], a4l: [842, 595], letter: [612, 792] };

  function wrapTextToWidth(text, font, fontSize, maxWidth) {
    const words = text.split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    words.forEach(function (w) {
      const test = line ? line + ' ' + w : w;
      if (font.widthOfTextAtSize(test, fontSize) > maxWidth && line) {
        lines.push(line);
        line = w;
      } else {
        line = test;
      }
    });
    if (line) lines.push(line);
    return lines;
  }

  // ══════════════════════════════════════════════════════════════════
  // WORD TO PDF
  // ══════════════════════════════════════════════════════════════════
  ServiceRunner.register({
    id: 'word-to-pdf',
    title: 'Word to PDF',
    icon: '📄',
    accept: '.docx',
    backTo: BACK,
    description: 'Turn a Word document into a PDF (text only - see note below).',
    setupHtml: function () {
      return `
        <div class="setup-group">
          <label>Page size</label>
          <select id="tWpSize" style="width:100%;">
            <option value="a4">A4 (portrait)</option>
            <option value="letter">Letter (portrait)</option>
          </select>
        </div>
        <div style="margin-top:10px;padding:8px 10px;border:1px solid #7aa7cc;background:#eef5fb;border-radius:6px;font-size:0.8rem;color:#2c5777;">
          This extracts the <b>text</b>, not the layout - tables, images and
          precise formatting are not reproduced. For a layout-faithful
          conversion, use the paid Translation service instead.
        </div>`;
    },
    process: async function (files, ctx, label) {
      need(typeof mammoth !== 'undefined' ? mammoth : undefined, 'mammoth (Word reader)');
      need(typeof PDFLib !== 'undefined' ? PDFLib : undefined, 'pdf-lib');
      const f = files[0];
      const sizeKey = (document.getElementById('tWpSize') || {}).value || 'a4';
      const PAGE = PDF_PAGE_SIZES[sizeKey] || PDF_PAGE_SIZES.a4;

      const result = await mammoth.extractRawText({ arrayBuffer: await f.arrayBuffer() });
      const text = (result.value || '').trim();
      if (!text) throw new Error('No readable text found in that document.');
      ctx.log(`${label} > Text Data = ${text.length} character(s)`, 'Info');

      const doc = await PDFLib.PDFDocument.create();
      const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
      const fontSize = 11, lineH = 15, margin = 50;
      const usableW = PAGE[0] - margin * 2;
      let page = doc.addPage(PAGE);
      let y = PAGE[1] - margin;

      const paragraphs = text.split(/\r?\n/);
      paragraphs.forEach(function (para, i) {
        const safe = para.replace(/[^\x20-\xFF]/g, '?');
        const lines = safe.trim() ? wrapTextToWidth(safe, font, fontSize, usableW) : [''];
        lines.forEach(function (line) {
          if (y < margin + lineH) { page = doc.addPage(PAGE); y = PAGE[1] - margin; }
          try { page.drawText(line, { x: margin, y: y, size: fontSize, font: font }); } catch (e) { /* skip un-encodable line */ }
          y -= lineH;
        });
        if (i % 20 === 0 && ctx.progress) ctx.progress((i / paragraphs.length) * 100);
      });

      const bytes = await doc.save();
      ctx.download(new Blob([bytes], { type: 'application/pdf' }), `${stem(f.name)}.pdf`);
      ctx.log(`${label} > Generate Output > ${stem(f.name)}.pdf (${doc.getPageCount()} page(s))`, 'Success');
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // EXCEL TO PDF
  // ══════════════════════════════════════════════════════════════════
  ServiceRunner.register({
    id: 'excel-to-pdf',
    title: 'Excel to PDF',
    icon: '📄',
    accept: '.xlsx,.xls',
    backTo: BACK,
    description: 'Turn a spreadsheet into a PDF, one row per line.',
    setupHtml: function () {
      return `
        <div class="setup-group">
          <label>Page size</label>
          <select id="tEpSize" style="width:100%;">
            <option value="a4">A4 (portrait)</option>
            <option value="a4l">A4 (landscape)</option>
            <option value="letter">Letter (portrait)</option>
          </select>
        </div>`;
    },
    process: async function (files, ctx, label) {
      need(typeof XLSX !== 'undefined' ? XLSX : undefined, 'the spreadsheet library');
      need(typeof PDFLib !== 'undefined' ? PDFLib : undefined, 'pdf-lib');
      const f = files[0];
      const sizeKey = (document.getElementById('tEpSize') || {}).value || 'a4';
      const PAGE = PDF_PAGE_SIZES[sizeKey] || PDF_PAGE_SIZES.a4;

      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }).map(function (r) {
        return r.map(function (c) { return String(c == null ? '' : c); });
      });
      if (!rows.length) throw new Error('That sheet appears to be empty.');
      ctx.log(`${label} > Sheet = ${wb.SheetNames[0]}`, 'Info');
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
          let text = String(cell);
          const maxChars = Math.max(1, Math.floor(colW / (fontSize * 0.5)));
          if (text.length > maxChars) text = text.slice(0, maxChars - 1) + '…';
          text = text.replace(/[^\x20-\xFF]/g, '?');
          try { page.drawText(text, { x: margin + c * colW, y: y, size: fontSize, font: font }); } catch (e) { /* skip un-encodable cell */ }
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
  // PASSPORT PHOTO MAKER
  // ══════════════════════════════════════════════════════════════════
  const PASSPORT_PRESETS = {
    'us-2x2': { label: 'US Passport/Visa (2x2 in)', wIn: 2, hIn: 2 },
    'in-35x45': { label: 'India Passport (35x45 mm)', wMm: 35, hMm: 45 },
    'uk-35x45': { label: 'UK Passport/Visa (35x45 mm)', wMm: 35, hMm: 45 },
    'schengen-35x45': { label: 'Schengen Visa (35x45 mm)', wMm: 35, hMm: 45 }
  };

  ServiceRunner.register({
    id: 'passport-photo-maker',
    title: 'Passport Photo Maker',
    icon: '🪪',
    accept: 'image/*',
    backTo: BACK,
    multiple: false,
    description: 'Crop and resize a photo to a standard passport/visa size, tiled onto a printable sheet.',
    setupHtml: function () {
      return `
        <div class="setup-group">
          <label>Size</label>
          <select id="tPpSize" style="width:100%;">
            ${Object.keys(PASSPORT_PRESETS).map(function (k) { return `<option value="${k}">${PASSPORT_PRESETS[k].label}</option>`; }).join('')}
          </select>
        </div>
        <div class="setup-group" style="margin-top:10px;">
          <label>Copies on sheet</label>
          <select id="tPpCopies" style="width:100%;">
            <option value="1">1 (just the photo)</option>
            <option value="4">4</option>
            <option value="6" selected>6</option>
            <option value="8">8</option>
          </select>
        </div>`;
    },
    process: async function (files, ctx, label) {
      const key = (document.getElementById('tPpSize') || {}).value || 'us-2x2';
      const copies = parseInt((document.getElementById('tPpCopies') || {}).value, 10) || 6;
      const preset = PASSPORT_PRESETS[key];
      const dpi = 300;
      const pxW = Math.round((preset.wIn || preset.wMm / 25.4) * dpi);
      const pxH = Math.round((preset.hIn || preset.hMm / 25.4) * dpi);

      const f = files[0];
      const img = await new Promise(function (resolve, reject) {
        const el = new Image();
        el.onload = function () { resolve(el); };
        el.onerror = function () { reject(new Error('Could not read that image.')); };
        el.src = URL.createObjectURL(f);
      });

      // Single cropped photo, centered "cover" crop to the target ratio.
      const single = document.createElement('canvas');
      single.width = pxW; single.height = pxH;
      const sctx = single.getContext('2d');
      const srcRatio = img.naturalWidth / img.naturalHeight;
      const dstRatio = pxW / pxH;
      let sx, sy, sw, sh;
      if (srcRatio > dstRatio) { sh = img.naturalHeight; sw = sh * dstRatio; sy = 0; sx = (img.naturalWidth - sw) / 2; }
      else { sw = img.naturalWidth; sh = sw / dstRatio; sx = 0; sy = (img.naturalHeight - sh) / 2; }
      sctx.drawImage(img, sx, sy, sw, sh, 0, 0, pxW, pxH);

      if (copies <= 1) {
        const blob = await new Promise(function (resolve) { single.toBlob(resolve, 'image/jpeg', 0.95); });
        ctx.download(blob, `${stem(f.name)}_passport.jpg`);
      } else {
        // Tile onto a 4x6in (300dpi) print-shop-style sheet with a small gap.
        const gap = 10;
        const cols = copies <= 4 ? 2 : (copies <= 6 ? 3 : 4);
        const rows = Math.ceil(copies / cols);
        const sheet = document.createElement('canvas');
        sheet.width = cols * pxW + (cols + 1) * gap;
        sheet.height = rows * pxH + (rows + 1) * gap;
        const shctx = sheet.getContext('2d');
        shctx.fillStyle = '#fff';
        shctx.fillRect(0, 0, sheet.width, sheet.height);
        for (let i = 0; i < copies; i++) {
          const col = i % cols, row = Math.floor(i / cols);
          shctx.drawImage(single, gap + col * (pxW + gap), gap + row * (pxH + gap));
        }
        const blob = await new Promise(function (resolve) { sheet.toBlob(resolve, 'image/jpeg', 0.95); });
        ctx.download(blob, `${stem(f.name)}_passport_sheet.jpg`);
      }
      ctx.log(`${label} > Size = ${preset.label}, ${copies} copy/copies`, 'Info');
      ctx.log(`${label} > Generate Output > ${stem(f.name)}_passport${copies > 1 ? '_sheet' : ''}.jpg`, 'Success');
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // MEME GENERATOR
  // ══════════════════════════════════════════════════════════════════
  ServiceRunner.register({
    id: 'meme-generator',
    title: 'Meme Generator',
    icon: '😂',
    accept: 'image/*',
    backTo: BACK,
    multiple: false,
    description: 'Add top/bottom caption text to an image.',
    setupHtml: function () {
      return `
        <div class="setup-group">
          <label>Top text</label>
          <input type="text" id="tMgTop" placeholder="TOP TEXT" style="width:100%;text-transform:uppercase;" />
        </div>
        <div class="setup-group" style="margin-top:10px;">
          <label>Bottom text</label>
          <input type="text" id="tMgBottom" placeholder="BOTTOM TEXT" style="width:100%;text-transform:uppercase;" />
        </div>`;
    },
    process: async function (files, ctx, label) {
      const top = ((document.getElementById('tMgTop') || {}).value || '').toUpperCase();
      const bottom = ((document.getElementById('tMgBottom') || {}).value || '').toUpperCase();
      if (!top && !bottom) throw new Error('Enter at least a top or bottom caption.');

      const f = files[0];
      const img = await new Promise(function (resolve, reject) {
        const el = new Image();
        el.onload = function () { resolve(el); };
        el.onerror = function () { reject(new Error('Could not read that image.')); };
        el.src = URL.createObjectURL(f);
      });

      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const cctx = canvas.getContext('2d');
      cctx.drawImage(img, 0, 0);

      const fontSize = Math.round(canvas.width * 0.09);
      cctx.font = `bold ${fontSize}px Impact, "Arial Black", sans-serif`;
      cctx.textAlign = 'center';
      cctx.fillStyle = '#fff';
      cctx.strokeStyle = '#000';
      cctx.lineWidth = Math.max(2, fontSize * 0.06);

      const drawCaption = function (text, y) {
        if (!text) return;
        cctx.strokeText(text, canvas.width / 2, y);
        cctx.fillText(text, canvas.width / 2, y);
      };
      drawCaption(top, fontSize * 1.1);
      drawCaption(bottom, canvas.height - fontSize * 0.4);

      const blob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
      ctx.download(blob, `${stem(f.name)}_meme.png`);
      ctx.log(`${label} > Generate Output > ${stem(f.name)}_meme.png`, 'Success');
    }
  });

  // Encodes a decoded AudioBuffer as a standard 16-bit PCM WAV file - no
  // external library needed, this format is simple enough to write by
  // hand. Used by both Video to Audio and the audio path of Trim.
  function audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const numFrames = buffer.length;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = numFrames * blockAlign;
    const bufferOut = new ArrayBuffer(44 + dataSize);
    const view = new DataView(bufferOut);

    const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bytesPerSample * 8, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    const channels = [];
    for (let c = 0; c < numChannels; c++) channels.push(buffer.getChannelData(c));
    let offset = 44;
    for (let i = 0; i < numFrames; i++) {
      for (let c = 0; c < numChannels; c++) {
        const sample = Math.max(-1, Math.min(1, channels[c][i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }
    return new Blob([bufferOut], { type: 'audio/wav' });
  }

  // ══════════════════════════════════════════════════════════════════
  // VIDEO TO AUDIO
  // ══════════════════════════════════════════════════════════════════
  ServiceRunner.register({
    id: 'video-to-audio',
    title: 'Video to Audio',
    icon: '🎵',
    accept: 'video/*',
    backTo: BACK,
    multiple: false,
    description: 'Pull the audio track out of a video as a WAV file.',
    setupHtml: function () { return ''; },
    process: async function (files, ctx, label) {
      const f = files[0];
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error('This browser does not support audio decoding.');
      const actx = new AudioContextClass();
      // decodeAudioData pulls just the audio track out of a video
      // container directly - no playback, no ffmpeg needed - as long as
      // the browser's media engine recognizes the audio codec inside it.
      const audioBuffer = await actx.decodeAudioData(await f.arrayBuffer())
        .catch(function () { throw new Error('Could not read an audio track from this video - the format/codec may not be supported.'); });
      ctx.log(`${label} > Duration = ${audioBuffer.duration.toFixed(1)}s, ${audioBuffer.numberOfChannels} channel(s)`, 'Info');
      const blob = audioBufferToWav(audioBuffer);
      ctx.download(blob, `${stem(f.name)}.wav`);
      ctx.log(`${label} > Generate Output > ${stem(f.name)}.wav`, 'Success');
      actx.close();
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // TRIM VIDEO/AUDIO
  // ══════════════════════════════════════════════════════════════════
  ServiceRunner.register({
    id: 'trim-video-audio',
    title: 'Trim Video/Audio',
    icon: '✂️',
    accept: 'video/*,audio/*',
    backTo: BACK,
    multiple: false,
    description: 'Cut a video or audio file down to a start/end time.',
    setupHtml: function () {
      return `
        <div style="display:flex;gap:12px;flex-wrap:wrap;">
          <div class="setup-group" style="flex:1;"><label>Start (seconds)</label><input type="number" id="tTvStart" value="0" min="0" step="0.1" style="width:100%;" /></div>
          <div class="setup-group" style="flex:1;"><label>End (seconds)</label><input type="number" id="tTvEnd" value="10" min="0" step="0.1" style="width:100%;" /></div>
        </div>
        <div style="font-size:0.78rem;color:rgba(0,0,0,0.5);margin-top:4px;">
          For video files, trimming plays the clip in the background to re-record it - it takes about as long as the trimmed length itself.
        </div>`;
    },
    process: async function (files, ctx, label) {
      const start = Math.max(0, parseFloat((document.getElementById('tTvStart') || {}).value) || 0);
      const end = parseFloat((document.getElementById('tTvEnd') || {}).value);
      if (!Number.isFinite(end) || end <= start) throw new Error('End time must be after the start time.');
      const f = files[0];
      const isAudio = f.type.indexOf('audio') === 0 || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(f.name);

      if (isAudio) {
        // Audio: decode, slice the buffer directly, re-encode as WAV -
        // fast, sample-accurate, no real-time playback needed.
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) throw new Error('This browser does not support audio decoding.');
        const actx = new AudioContextClass();
        const buffer = await actx.decodeAudioData(await f.arrayBuffer());
        const clampedEnd = Math.min(end, buffer.duration);
        if (start >= clampedEnd) throw new Error(`That file is only ${buffer.duration.toFixed(1)}s long - start must be before the end.`);
        const startFrame = Math.floor(start * buffer.sampleRate);
        const endFrame = Math.floor(clampedEnd * buffer.sampleRate);
        const frameCount = endFrame - startFrame;
        const trimmed = actx.createBuffer(buffer.numberOfChannels, frameCount, buffer.sampleRate);
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          trimmed.copyToChannel(buffer.getChannelData(c).subarray(startFrame, endFrame), c);
        }
        const blob = audioBufferToWav(trimmed);
        ctx.download(blob, `${stem(f.name)}_trimmed.wav`);
        ctx.log(`${label} > Trimmed to ${start}s-${clampedEnd.toFixed(1)}s`, 'Info');
        ctx.log(`${label} > Generate Output > ${stem(f.name)}_trimmed.wav`, 'Success');
        actx.close();
        return;
      }

      // Video: play the clip in a hidden <video> element and re-record
      // it live via captureStream()+MediaRecorder between start and end -
      // there's no way to cut video frames out of a file directly in the
      // browser without a library like ffmpeg.wasm, so this is the
      // browser-native alternative. Output is WebM (MediaRecorder's
      // native format), and re-encodes the clip rather than being a
      // lossless cut.
      if (typeof MediaRecorder === 'undefined') throw new Error('This browser does not support video recording.');
      const video = document.createElement('video');
      video.src = URL.createObjectURL(f);
      video.muted = false;
      video.playsInline = true;
      await new Promise(function (resolve, reject) {
        video.onloadedmetadata = resolve;
        video.onerror = function () { reject(new Error('Could not read that video file.')); };
      });
      const clampedEnd = Math.min(end, video.duration);
      if (start >= clampedEnd) throw new Error(`That file is only ${video.duration.toFixed(1)}s long - start must be before the end.`);

      const stream = video.captureStream ? video.captureStream() : video.mozCaptureStream();
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
      const chunks = [];
      recorder.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };

      video.currentTime = start;
      await new Promise(function (resolve) { video.onseeked = resolve; });

      await new Promise(function (resolve, reject) {
        recorder.onstop = resolve;
        recorder.start();
        video.play().catch(reject);
        const checkEnd = function () {
          if (video.currentTime >= clampedEnd || video.ended) { recorder.stop(); video.pause(); return; }
          if (ctx.progress) ctx.progress(((video.currentTime - start) / (clampedEnd - start)) * 100);
          requestAnimationFrame(checkEnd);
        };
        requestAnimationFrame(checkEnd);
      });

      const blob = new Blob(chunks, { type: 'video/webm' });
      ctx.download(blob, `${stem(f.name)}_trimmed.webm`);
      ctx.log(`${label} > Trimmed to ${start}s-${clampedEnd.toFixed(1)}s`, 'Info');
      ctx.log(`${label} > Generate Output > ${stem(f.name)}_trimmed.webm`, 'Success');
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // JSON TO CSV
  // ══════════════════════════════════════════════════════════════════
  ServiceRunner.register({
    id: 'json-to-csv',
    title: 'JSON to CSV',
    icon: '🔄',
    accept: '.json,application/json',
    backTo: BACK,
    description: 'Upload a JSON file (an object, or an array of objects), get a CSV back.',
    setupHtml: function () { return ''; },
    process: async function (files, ctx, label) {
      const f = files[0];
      const text = await f.text();
      let data;
      try { data = JSON.parse(text); } catch (e) { throw new Error('That file is not valid JSON.'); }
      // A single JSON object (not wrapped in an array) is a perfectly
      // reasonable thing to upload - convert it to a one-row CSV instead
      // of rejecting it.
      if (data && typeof data === 'object' && !Array.isArray(data)) data = [data];
      if (!Array.isArray(data)) throw new Error('Expected a JSON object or an array of objects.');
      if (!data.length) throw new Error('That array is empty.');

      const heads = [];
      data.forEach(function (o) {
        Object.keys(o || {}).forEach(function (k) { if (heads.indexOf(k) === -1) heads.push(k); });
      });
      const cell = (v) => {
        const s = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const csv = [heads.join(',')].concat(data.map(function (o) {
        return heads.map(function (h) { return cell(o ? o[h] : ''); }).join(',');
      })).join('\n');

      ctx.download(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }), `${stem(f.name)}.csv`);
      ctx.log(`${label} > Records = ${data.length}`, 'Info');
      ctx.log(`${label} > Generate Output > ${stem(f.name)}.csv`, 'Success');
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // CSV/EXCEL TO JSON
  // ══════════════════════════════════════════════════════════════════
  ServiceRunner.register({
    id: 'csv-to-json',
    title: 'CSV/Excel to JSON',
    icon: '🔄',
    accept: '.csv,.xlsx,.xls,text/csv',
    backTo: BACK,
    description: 'Upload a CSV or Excel file, get JSON back.',
    setupHtml: function () { return ''; },
    process: async function (files, ctx, label) {
      const f = files[0];
      let csvText;
      if (/\.(xlsx|xls)$/i.test(f.name)) {
        need(typeof XLSX !== 'undefined' ? XLSX : undefined, 'SheetJS');
        const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
        csvText = XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]);
        ctx.log(`${label} > Sheet = ${wb.SheetNames[0]}`, 'Info');
      } else {
        csvText = await f.text();
      }

      // Same small CSV parser other tools already use (js/tools-docs.js
      // has its own copy for the paste-based tools) - simple RFC4180-ish
      // parsing: handles quoted fields, escaped quotes, commas/newlines
      // inside quotes.
      const rows = [];
      let row = [], cell = '', inQuotes = false;
      for (let i = 0; i < csvText.length; i++) {
        const c = csvText[i], next = csvText[i + 1];
        if (inQuotes) {
          if (c === '"' && next === '"') { cell += '"'; i++; }
          else if (c === '"') { inQuotes = false; }
          else { cell += c; }
        } else if (c === '"') {
          inQuotes = true;
        } else if (c === ',') {
          row.push(cell); cell = '';
        } else if (c === '\n' || c === '\r') {
          if (c === '\r' && next === '\n') i++;
          row.push(cell); cell = '';
          rows.push(row); row = [];
        } else {
          cell += c;
        }
      }
      if (cell || row.length) { row.push(cell); rows.push(row); }
      const cleanRows = rows.filter(function (r) { return r.length > 1 || r[0] !== ''; });

      if (cleanRows.length < 2) throw new Error('Need a header row plus at least one data row.');
      const heads = cleanRows[0].map(function (h) { return String(h).trim(); });
      const objs = cleanRows.slice(1).map(function (r) {
        const o = {}; heads.forEach(function (h, i) { o[h] = r[i] == null ? '' : r[i]; }); return o;
      });

      ctx.download(new Blob([JSON.stringify(objs, null, 2)], { type: 'application/json' }), `${stem(f.name)}.json`);
      ctx.log(`${label} > Rows read = ${objs.length}`, 'Info');
      ctx.log(`${label} > Generate Output > ${stem(f.name)}.json`, 'Success');
    }
  });

  window.ToolsFiles = {
    onPreset: onPreset,
    fillForm: fillForm,
    lineDiff: lineDiff
  };
})();
