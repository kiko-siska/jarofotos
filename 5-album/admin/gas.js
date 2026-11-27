/* Client for the Apps Script web app (google-apps-script/Code.gs, doPost): codes for the client galleries.
   The body goes as text/plain on purpose: that is a "simple" request, so the browser sends no preflight, which Apps Script cannot answer. */

export class GasError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const TEXT = {
  not_configured: 'V Apps Skripte ešte nie je nastavené heslo správcu (v tabuľke: menu Jarofotos → Nastaviť heslo správcu).',
  unauthorized: 'Heslo správcu galérií nesedí.',
  busy: 'Príliš veľa nesprávnych pokusov. Skúste to o minútu.',
  not_found: 'Táto galéria už neexistuje (obnovte zoznam).',
  title: 'Zadajte názov galérie.',
  folder: 'Odkaz na priečinok z Disku nie je platný, alebo k nemu skript nemá prístup.',
  date: 'Dátum nie je platný.',
  share: 'Priečinok sa nepodarilo zdieľať odkazom. Nastavte to na Disku ručne: Zdieľať → Ktokoľvek s odkazom → Čitateľ.',
  server: 'Apps Script hlási chybu. Skúste to znova; ak sa to opakuje, pozrite Vykonania (Executions) v Apps Skripte.',
  bad_action: 'Apps Script je starší, než táto správa. Vydajte novú verziu nasadenia (návod: NAVOD.md).',
};

export async function gasCall(apiUrl, password, action, params = {}) {
  let res;
  try {
    res = await fetch(apiUrl, {
      method: 'POST', redirect: 'follow', cache: 'no-store',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, password, webBase: new URL('../galeria/', location.href).href, ...params }),
    });
  } catch {
    throw new GasError('network', 'Nepodarilo sa spojiť s Apps Scriptom. Skontrolujte adresu v Nastaveniach a internet.');
  }
  let j;
  try { j = await res.json(); } catch {
    throw new GasError('format', 'Apps Script neodpovedal v očakávanom tvare. Skontrolujte, že adresa končí na /exec a nasadenie má prístup „Ktokoľvek“.');
  }
  if (j && j.ok) return j;
  const code = (j && j.error) || 'server';
  throw new GasError(code, TEXT[code] || `Chyba: ${code}`);
}
