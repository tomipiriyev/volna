// SVG and PNG export of on-screen plots. Plots are styled with CSS variables,
// so the exported copy gets every element's computed paint and text styles
// inlined, plus a background, and renders the same outside the app.

const STYLE_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-opacity', 'opacity', 'font-size', 'font-family', 'font-weight', 'text-anchor', 'dominant-baseline'];

export function svgToString(live: SVGSVGElement): string {
  const clone = live.cloneNode(true) as SVGSVGElement;
  const src = live.querySelectorAll('*'), dst = clone.querySelectorAll('*');
  src.forEach((el, i) => {
    const cs = getComputedStyle(el);
    dst[i].setAttribute('style', STYLE_PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';'));
    dst[i].removeAttribute('class');
  });
  // Interactive overlays (hover readouts) are not part of the figure.
  clone.querySelectorAll('[data-export="skip"]').forEach((el) => el.remove());
  const vb = live.viewBox.baseVal;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(vb.width));
  clone.setAttribute('height', String(vb.height));
  clone.removeAttribute('class');
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', String(vb.x));
  bg.setAttribute('y', String(vb.y));
  bg.setAttribute('width', String(vb.width));
  bg.setAttribute('height', String(vb.height));
  bg.setAttribute('fill', getComputedStyle(document.documentElement).getPropertyValue('--panel').trim() || '#ffffff');
  clone.insertBefore(bg, clone.firstChild);
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
}

export async function svgToPngBlob(live: SVGSVGElement, scale = 3): Promise<Blob> {
  const svg = svgToString(live);
  const vb = live.viewBox.baseVal;
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('could not render the plot image'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vb.width * scale);
    canvas.height = Math.round(vb.height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function download(content: Blob | string, fileName: string, mime = 'text/plain') {
  const blob = typeof content === 'string' ? new Blob([content], { type: mime }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** File-name-safe stem. */
export const safeName = (s: string) => s.replace(/\.(step|stp)$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'antsim';
