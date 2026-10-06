// Shared DOM→raster core for every generated artifact (statement PDF, group
// settle-up PDF, Hisaab Wrapped image card, kameti payout slip).
//
// Builds a self-contained, inline-styled node offscreen, rasterises it with
// modern-screenshot, and (for PDFs) places the PNG onto an A4 page with jsPDF.
// Rendering the DOM — rather than drawing text — lets the BROWSER shape the text
// so any script (Urdu/Arabic) renders correctly. Both libraries are lazy
// dynamic-imported so they never touch the initial app bundle.

export interface RenderPngOptions {
  width: number; // CSS px width of the node
  height?: number; // fixed CSS px height (portrait cards); omit for natural height
  scale?: number; // raster scale (default 2; use ~1.5 for large portrait nodes)
  nodeStyle?: string; // extra inline style appended to the offscreen node
  backgroundColor?: string; // default #ffffff
}

export interface RenderedPng {
  blob: Blob;
  dataUrl: string;
  width: number; // measured CSS px
  height: number; // measured CSS px
}

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const head = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  const mime = head.match(/data:(.*?);base64/)?.[1] ?? 'image/png';
  const bin = atob(body);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// Rasterise an HTML string to a PNG. Returns the blob (for sharing an image) and
// the data URL (for embedding into a PDF), plus the measured dimensions.
export async function renderHtmlToPng(html: string, opts: RenderPngOptions): Promise<RenderedPng> {
  const { domToPng } = await import('modern-screenshot');
  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed',
    'left:-10000px',
    'top:0',
    'pointer-events:none',
    'box-sizing:border-box',
    `background:${opts.backgroundColor ?? '#ffffff'}`,
    `width:${opts.width}px`,
    opts.height ? `height:${opts.height}px` : '',
    opts.nodeStyle ?? '',
  ].filter(Boolean).join(';');
  el.innerHTML = html;
  document.body.appendChild(el);
  try {
    // Two paints so layout + fonts settle before the snapshot.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const rect = el.getBoundingClientRect();
    const width = Math.round(rect.width || opts.width);
    const height = Math.round(rect.height || opts.height || opts.width * 1.414);
    const dataUrl = await domToPng(el, {
      scale: opts.scale ?? 2,
      backgroundColor: opts.backgroundColor ?? '#ffffff',
      width,
      height,
    });
    return { blob: dataUrlToBlob(dataUrl), dataUrl, width, height };
  } finally {
    el.remove();
  }
}

// Mount each page offscreen and read its laid-out height — no rasterising, so
// it is cheap. A multi-page document uses this to prove every page fits its
// A4 box BEFORE drawing anything: a money document never clips rows silently.
export async function measureHtmlHeights(
  pages: readonly string[],
  opts: Pick<RenderPngOptions, 'width' | 'nodeStyle'>,
): Promise<number[]> {
  const out: number[] = [];
  for (const html of pages) {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'left:-10000px', 'top:0', 'pointer-events:none', 'box-sizing:border-box',
      `width:${opts.width}px`, opts.nodeStyle ?? '',
    ].filter(Boolean).join(';');
    el.innerHTML = html;
    document.body.appendChild(el);
    try {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      out.push(Math.ceil(el.getBoundingClientRect().height || el.scrollHeight));
    } finally {
      el.remove();
    }
  }
  return out;
}

export interface RenderPdfMeta {
  title?: string;
  subject?: string;
  author?: string;
  creator?: string;
}

// Rasterise an HTML string and place it on a single A4 portrait page. Fits to
// page width; clamps to page height for very tall content so it stays one page.
export async function renderHtmlToA4Pdf(html: string, opts: RenderPngOptions & RenderPdfMeta): Promise<Blob> {
  const [{ jsPDF }, png] = await Promise.all([import('jspdf'), renderHtmlToPng(html, opts)]);
  const pageW = 595.28;
  const pageH = 841.89;
  const ratio = png.height / png.width;
  let drawW = pageW;
  let drawH = pageW * ratio;
  if (drawH > pageH) {
    drawH = pageH;
    drawW = pageH / ratio;
  }
  const offsetX = (pageW - drawW) / 2;
  const pdf = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait' });
  pdf.addImage(png.dataUrl, 'PNG', offsetX, 0, drawW, drawH, undefined, 'FAST');
  pdf.setProperties({
    title: opts.title ?? '',
    subject: opts.subject ?? '',
    author: opts.author ?? 'Hisaab',
    creator: opts.creator ?? 'Hisaab',
  });
  return pdf.output('blob') as Blob;
}

export interface RenderPagesOptions extends RenderPdfMeta {
  width: number; // CSS px width of every page node
  height: number; // fixed CSS px height of every page node (A4 box)
  nodeStyle?: string;
  scale?: number; // default 1.5 — ~2 MP per page
  quality?: number; // JPEG quality, default 0.88
  onProgress?: (done: number, total: number) => void;
}

// A multi-page A4 PDF, one pre-paginated HTML string per page. Pages are
// rasterised ONE AT A TIME as JPEG (jsPDF embeds JPEG as-is, PNG it decodes
// and re-compresses) so peak memory on an Android WebView is a single page,
// and the file stays small enough for the Capacitor share bridge (it base64s
// the whole blob). Every page fills the A4 box exactly — the pages were cut
// to fit by the caller, never scaled down here.
export async function renderPagesToA4Pdf(pages: readonly string[], opts: RenderPagesOptions): Promise<Blob> {
  const [{ jsPDF }, { domToJpeg }] = await Promise.all([import('jspdf'), import('modern-screenshot')]);
  const pageW = 595.28;
  const pageH = 841.89;
  const pdf = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait' });
  for (let i = 0; i < pages.length; i++) {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'left:-10000px', 'top:0', 'pointer-events:none', 'box-sizing:border-box',
      'background:#ffffff', `width:${opts.width}px`, `height:${opts.height}px`, 'overflow:hidden',
      opts.nodeStyle ?? '',
    ].filter(Boolean).join(';');
    el.innerHTML = pages[i];
    document.body.appendChild(el);
    try {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      let dataUrl: string | null = await domToJpeg(el, {
        scale: opts.scale ?? 1.5,
        quality: opts.quality ?? 0.88,
        backgroundColor: '#ffffff',
        width: opts.width,
        height: opts.height,
      });
      if (i > 0) pdf.addPage('a4', 'portrait');
      pdf.addImage(dataUrl, 'JPEG', 0, 0, pageW, pageH, undefined, 'FAST');
      dataUrl = null; // let the page's pixels go before the next one
    } finally {
      el.remove();
    }
    opts.onProgress?.(i + 1, pages.length);
    await new Promise((r) => setTimeout(r, 0));
  }
  pdf.setProperties({
    title: opts.title ?? '',
    subject: opts.subject ?? '',
    author: opts.author ?? 'Hisaab',
    creator: opts.creator ?? 'Hisaab',
  });
  return pdf.output('blob') as Blob;
}
