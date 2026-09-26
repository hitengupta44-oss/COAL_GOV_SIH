// jsPDF, loaded on demand from the CDN (the service worker caches it for
// offline use). Shared by the reports and statutory-return downloads.
const JSPDF = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
const AUTOTABLE = "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js";

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const found = document.querySelector(`script[src="${src}"]`);
    if (found) {
      if (found.dataset.loaded) return resolve();
      found.addEventListener("load", () => resolve());
      found.addEventListener("error", () => reject(new Error(`Could not load ${src}`)));
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => { s.dataset.loaded = "1"; resolve(); };
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

export async function loadPdf() {
  await loadScript(JSPDF);
  await loadScript(AUTOTABLE);
  return window.jspdf.jsPDF;
}
