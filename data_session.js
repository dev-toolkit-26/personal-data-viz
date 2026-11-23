/* ════════════════════════════════════════════════════════════════════
 *  data_session.js — Supabase 데이터 요청을 "비밀번호 통과 세션"으로 보내는 공용 모듈
 *  (보안 B안: migrations/security_b1_session_grants.sql / security_b2_lockdown.sql)
 *
 *  동작
 *   1) 비밀번호 확인 후 DataSession.activate(비밀번호)
 *      → Supabase 익명 로그인 세션 확보 → claim_session RPC로 그 세션에 권한 부여
 *   2) DataSession.fetch 를 거치는 모든 REST 요청은 activate가 끝날 때까지 대기했다가
 *      권한 받은 세션의 JWT로 나간다. (supabase-js: createClient의 global.fetch로 연결,
 *      kpi.html 같은 직접 fetch: DataSession.fetch로 호출)
 *   3) 권한 부여에 실패하면(익명 로그인 꺼짐·1단계 SQL 미적용 등) 공개 키로 진행한다.
 *      → 2단계(잠금) 적용 전에는 기존과 똑같이 동작, 적용 후에는 데이터가 안 읽힘.
 *  /auth/v1/·/functions/v1/ 요청은 대기·헤더 변경 없이 그대로 통과(로그인 자체가 막히지 않게).
 * ════════════════════════════════════════════════════════════════════ */
(function (g) {
  'use strict';
  if (g.DataSession) return;

  var cfg = { url: '', key: '' };
  var client = null;
  var started = null;
  var resolveReady;
  var ready = new Promise(function (r) { resolveReady = r; });
  var state = { status: 'idle' };      // idle | pending | granted | denied | fallback

  function init(opts) {
    cfg.url = opts.url; cfg.key = opts.key;
    return api;
  }

  // supabase-js 클라이언트를 세션 관리용으로 연결 (페이지당 1개)
  function attach(c) {
    if (!client && c && c.auth) client = c;
    return c;
  }

  async function sessionToken() {
    if (!client) return null;
    try {
      var r = await client.auth.getSession();
      var s = r && r.data && r.data.session;
      return s ? s.access_token : null;
    } catch (e) { return null; }
  }

  async function claim(pw, jwt) {
    var res = await fetch(cfg.url + '/rest/v1/rpc/claim_session', {
      method: 'POST',
      headers: { apikey: cfg.key, Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_token: pw })
    });
    if (!res.ok) throw new Error('claim_session HTTP ' + res.status);
    return res.json();
  }

  function finish(next) {
    state = next;
    if (state.status !== 'granted') {
      console.warn('[DataSession] 세션 권한 없음(' + state.status + ') — 공개 키로 진행', state.error || '');
    }
    resolveReady();
    return state;
  }

  // 비밀번호 통과 직후 / 이미 로그인된 상태로 페이지를 열 때 호출. 여러 번 불러도 1회만 실행.
  function activate(pw) {
    if (started) return started;
    if (!pw) return Promise.resolve(state);
    state = { status: 'pending' };
    started = (async function () {
      try {
        if (!client) throw new Error('supabase client 미연결');
        var r = await client.auth.getSession();
        var s = r && r.data && r.data.session;
        if (!s) {
          var a = await client.auth.signInAnonymously();
          if (a.error) throw a.error;
          s = a.data.session;
        }
        var out = await claim(pw, s.access_token);
        if (out && out.ok) return finish({ status: 'granted', scope: out.scope, is_admin: !!out.is_admin, label: out.label });
        return finish({ status: 'denied', error: (out && out.error) || 'invalid_token' });
      } catch (e) {
        return finish({ status: 'fallback', error: String((e && e.message) || e) });
      }
    })();
    return started;
  }

  // 로그인 정보 없이 열린 화면(단독으로 연 iframe 등): 대기 없이 공개 키로 진행
  function skip() {
    if (started) return started;
    started = Promise.resolve(finish({ status: 'fallback', error: 'no_login' }));
    return started;
  }

  function urlOf(input) { return typeof input === 'string' ? input : (input && input.url) || String(input); }

  // createClient(..., { global: { fetch: DataSession.fetch } }) 및 직접 REST 호출용
  async function dsFetch(input, init) {
    var url = urlOf(input);
    if (url.indexOf('/auth/v1/') >= 0 || url.indexOf('/functions/v1/') >= 0 || url.indexOf('/rpc/claim_session') >= 0) {
      return fetch(input, init);
    }
    if (url.indexOf(cfg.url) !== 0) return fetch(input, init);
    await ready;
    var bearer = state.status === 'granted' ? await sessionToken() : null;
    var h = new Headers((init && init.headers) || (typeof input !== 'string' && input.headers) || {});
    h.set('apikey', cfg.key);
    h.set('Authorization', 'Bearer ' + (bearer || cfg.key));
    var next = Object.assign({}, init || {}, { headers: h });
    return fetch(input, next);
  }

  var api = {
    init: init,
    attach: attach,
    activate: activate,
    skip: skip,
    fetch: dsFetch,
    ready: function () { return ready; },
    state: function () { return state; }
  };
  g.DataSession = api;
})(window);
