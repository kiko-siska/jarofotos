/* A small GitHub client for the admin page: read files, and publish one atomic commit (blobs, tree, commit, branch update).
   The token never leaves the browser except as the Authorization header to the GitHub API address below. */

export class GitHubError extends Error {
  constructor(kind, message, status) { super(message); this.kind = kind; this.status = status; }
}

const b64 = (bytes) => { // btoa in chunks (a big spread would overflow the call stack)
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s) => Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0));

export class GitHub {
  /** apiBase is only overridable on localhost (tests): a link must never be able to point the token at another server. */
  constructor({ repo, branch = 'main', token, apiBase = 'https://api.github.com' }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new GitHubError('repo', 'Repozitár zadajte v tvare majitel/nazov.');
    this.repo = repo; this.branch = branch; this.token = token; this.api = apiBase.replace(/\/$/, '');
  }

  async req(method, path, body) {
    let res;
    try {
      res = await fetch(`${this.api}${path}`, {
        method, cache: 'no-store',
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, // only headers GitHub's CORS answer is known to allow
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new GitHubError('network', 'Nepodarilo sa spojiť s GitHubom. Skontrolujte internet a skúste to znova.');
    }
    if (res.ok) return res.status === 204 ? null : res.json();
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch { /* no body */ }
    if (res.status === 401) throw new GitHubError('auth', 'GitHub token nie je platný alebo vypršal. Vytvorte nový v časti Nastavenia.', 401);
    if (res.status === 403 && /rate limit/i.test(msg)) throw new GitHubError('rate', 'GitHub dočasne obmedzil počet požiadaviek. Skúste to o pár minút.', 403);
    if (res.status === 403 || res.status === 404) throw new GitHubError('access', `Token nemá prístup k repozitáru ${this.repo} (alebo repozitár neexistuje), prípadne nemá právo „Contents: Read and write“.`, res.status);
    throw new GitHubError('api', `GitHub odpovedal chybou ${res.status}${msg ? `: ${msg}` : ''}`, res.status);
  }

  user() { return this.req('GET', '/user'); }

  /** The repository, plus whether this token may write to it. */
  async check() {
    const r = await this.req('GET', `/repos/${this.repo}`);
    if (r.permissions && !r.permissions.push) throw new GitHubError('access', `Token môže repozitár ${this.repo} len čítať. Potrebuje právo „Contents: Read and write“.`, 403);
    return r;
  }

  /** A text file at a branch or commit: { sha, text }, or null when it does not exist. */
  async file(path, ref = this.branch) {
    try {
      const r = await this.req('GET', `/repos/${this.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
      return { sha: r.sha, text: new TextDecoder().decode(fromB64(r.content)) };
    } catch (e) {
      if (e.kind === 'access' && e.status === 404) return null;
      throw e;
    }
  }

  async head() {
    const r = await this.req('GET', `/repos/${this.repo}/git/ref/heads/${encodeURIComponent(this.branch)}`);
    return r.object.sha;
  }

  /**
   * One commit with all the changes. files: [{ path, text } | { path, bytes }], deletes: [path].
   * guard: [{ path, sha }]. Before the commit is attached, each guarded file must still have that blob sha on the branch
   * (somebody else may have changed the content or a template since this page loaded them): otherwise a ConflictError.
   */
  async commit({ message, files, deletes = [], guard = [], onProgress = () => {} }) {
    const shas = new Map();
    let done = 0;
    const total = files.length;
    const queue = [...files];
    const worker = async () => {
      for (let f; (f = queue.shift());) {
        const body = f.bytes ? { content: b64(f.bytes), encoding: 'base64' } : { content: f.text, encoding: 'utf-8' };
        const r = await this.req('POST', `/repos/${this.repo}/git/blobs`, body);
        shas.set(f.path, r.sha);
        onProgress({ stage: 'upload', done: ++done, total });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));

    for (let attempt = 0; attempt < 4; attempt++) {
      const head = await this.head();
      for (const g of guard) {
        const now = await this.file(g.path, head);
        if ((now ? now.sha : null) !== g.sha) throw new GitHubError('conflict', 'Web sa medzitým zmenil (niekto iný uložil zmeny). Načítajte správu znova, aby ste neprepísali jeho prácu.');
      }
      const base = (await this.req('GET', `/repos/${this.repo}/git/commits/${head}`)).tree.sha;
      const tree = await this.req('POST', `/repos/${this.repo}/git/trees`, {
        base_tree: base,
        tree: [
          ...files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', sha: shas.get(f.path) })),
          ...deletes.map((path) => ({ path, mode: '100644', type: 'blob', sha: null })),
        ],
      });
      onProgress({ stage: 'commit' });
      const commit = await this.req('POST', `/repos/${this.repo}/git/commits`, { message, tree: tree.sha, parents: [head] });
      try {
        await this.req('PATCH', `/repos/${this.repo}/git/refs/heads/${encodeURIComponent(this.branch)}`, { sha: commit.sha, force: false });
        return { commit: commit.sha, blobs: Object.fromEntries(shas) };
      } catch (e) {
        if (e.kind === 'api' && e.status === 422) continue; // not a fast-forward: the branch moved meanwhile; check the guards again and retry
        throw e;
      }
    }
    throw new GitHubError('conflict', 'Nepodarilo sa uložiť zmeny, lebo sa web na GitHube stále mení. Skúste to o chvíľu.');
  }
}
