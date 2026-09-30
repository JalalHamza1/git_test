// Serves the real Index.html (rendered by doGet in the mock) and bridges google.script.run to the mock server.
'use strict';
const http = require('http');
const { makeEnv } = require('./lite_gas');

function start(port) {
  const env = makeEnv({ verbose: false });
  env.as('owner@example.com');
  env.call('setup');
  env.call('exampleData');
  env.setConfig('EMAILY', 'ANO');
  env.setConfig('EMAIL_KVALITA', 'kvalita@example.com');
  let offline = false;

  const clientMock = `<script>
  (function(){
    const AS = new URLSearchParams(location.search).get('as') || '';
    function runner(ok, fail) {
      return new Proxy({}, { get(_, name) {
        if (name === 'withSuccessHandler') return fn => runner(fn, fail);
        if (name === 'withFailureHandler') return fn => runner(ok, fn);
        return (...args) => {
          fetch('/api', { method: 'POST', body: JSON.stringify({ fn: name, args, as: AS }) })
            .then(r => r.ok ? r.json() : Promise.reject(new Error('NetworkError: Connection failure due to HTTP ' + r.status)))
            .then(res => { if (res && res.__error) fail && fail(new Error(res.__error)); else ok && ok(res.value); })
            .catch(e => fail && fail(e));
        };
      } });
    }
    let handler = null;
    window.google = { script: {
      run: runner(null, null),
      history: {
        push(state, params) { const q = new URLSearchParams(params); q.set('as', AS); history.pushState(state, '', '?' + q); },
        replace(state, params) { const q = new URLSearchParams(params); q.set('as', AS); history.replaceState(state, '', '?' + q); },
        setChangeHandler(fn) { handler = fn; }
      }
    } };
    window.addEventListener('popstate', () => { const p = Object.fromEntries(new URLSearchParams(location.search)); delete p.as; handler && handler({ location: { parameter: p } }); });
  })();
  </script>`;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/api') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        if (offline) { res.writeHead(503); res.end(); return; }
        const b = JSON.parse(body);
        env.as(b.as);
        let out;
        env.state.calls.api = (env.state.calls.api || 0) + 1;
        try { out = { value: env.call(b.fn, ...b.args) }; } catch (e) { console.log('SERVER THROW', b.fn, e.stack); out = { __error: String(e.message) }; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      });
      return;
    }
    if (url.pathname === '/calls') { res.end(String(env.state.calls.api || 0)); return; }
    if (url.pathname === '/offline') { offline = url.searchParams.get('on') === '1'; res.end('ok'); return; }
    if (url.pathname === '/') {
      const params = Object.fromEntries(url.searchParams);
      env.as(params.as || '');
      delete params.as;
      env.ctx.__p = params;
      let html = env.run('doGet({parameter: __p}).getContent()');
      html = html.replace('<body>', '<body>' + clientMock);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise(r => server.listen(port, () => r({ server, env })));
}
module.exports = { start };
