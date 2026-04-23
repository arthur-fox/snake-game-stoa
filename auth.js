    const SUPABASE_URL = 'https://nsvienlugithpmehukjt.supabase.co';
    const SUPABASE_KEY = 'sb_publishable_nyCIqLLTzWN7_im_rdFhVw_QHdgkdtw';
    let sb = null;
    try { sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY); } catch(e) { console.warn('Supabase unavailable, guest-only mode.'); }

    let currentUser = null;

    function generateClientSessionId() {
      try {
        if (window.crypto?.randomUUID) {
          return `session-${window.crypto.randomUUID()}`;
        }
      } catch (error) {}

      return `session-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
    }

    const clientSessionId = generateClientSessionId();

    // ── Auth UI ───────────────────────────────────────────────
    const authModal    = document.getElementById('auth-modal');
    const authTitle    = document.getElementById('auth-title');
    const authUsername = document.getElementById('auth-username');
    const authPassword = document.getElementById('auth-password');
    const authError    = document.getElementById('auth-error');
    const authSubmit   = document.getElementById('auth-submit');

    let authMode = 'login';

    function setupToggle() {
      const link = document.getElementById('auth-toggle-link');
      const wrap = document.getElementById('auth-toggle');
      link.onclick = () => {
        authMode = authMode === 'signup' ? 'login' : 'signup';
        const isSignup = authMode === 'signup';
        authTitle.textContent  = isSignup ? 'Sign Up' : 'Log In';
        authSubmit.textContent = isSignup ? 'Sign Up' : 'Log In';
        wrap.innerHTML = isSignup
          ? 'Already have an account? <span id="auth-toggle-link">Log in</span>'
          : 'No account? <span id="auth-toggle-link">Sign up</span>';
        authError.textContent = '';
        setupToggle();
      };
    }
    setupToggle();

    authSubmit.addEventListener('click', submitAuth);
    authPassword.addEventListener('keydown', e => { if (e.key === 'Enter') submitAuth(); });
    document.getElementById('guest-btn').addEventListener('click', playAsGuest);

    async function submitAuth() {
      if (!sb) { authError.textContent = 'No connection — use Play as Guest.'; return; }
      const username = authUsername.value.trim();
      const password = authPassword.value;

      if (!username) { authError.textContent = 'Please enter a username.'; return; }
      if (!/^[a-zA-Z0-9_]{1,20}$/.test(username)) {
        authError.textContent = 'Letters, numbers, underscores only.'; return;
      }
      if (password.length < 6) { authError.textContent = 'Password must be at least 6 characters.'; return; }

      authSubmit.disabled    = true;
      authSubmit.textContent = authMode === 'signup' ? 'Signing up…' : 'Logging in…';
      authError.textContent  = '';

      const email = `${username.toLowerCase()}@snake.local`;
      const result = authMode === 'signup'
        ? await sb.auth.signUp({ email, password, options: { data: { username } } })
        : await sb.auth.signInWithPassword({ email, password });

      const { data, error } = result;

      if (error) {
        const msg = error.message || '';
        if (msg.includes('already registered') || msg.includes('already been registered')) {
          authError.textContent = 'Username already taken.';
        } else if (msg.includes('Invalid login') || msg.includes('invalid_credentials') || msg.includes('Invalid email or password')) {
          authError.textContent = 'Invalid username or password.';
        } else {
          authError.textContent = msg;
        }
        authSubmit.disabled    = false;
        authSubmit.textContent = authMode === 'signup' ? 'Sign Up' : 'Log In';
        return;
      }

      currentUser = {
        id:       data.user.id,
        username: data.user.user_metadata?.username || username,
      };
      startAuthTransitionAnimation(() => showGame());
    }

    function getGuestUsername() {
      const storageKey = 'snake_guest_username';
      try {
        const existing = sessionStorage.getItem(storageKey);
        if (existing) return existing;
        const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
        const generated = `Guest-${suffix}`;
        sessionStorage.setItem(storageKey, generated);
        return generated;
      } catch (error) {
        const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
        return `Guest-${suffix}`;
      }
    }

    function playAsGuest() {
      currentUser = { id: null, username: getGuestUsername() };
      startAuthTransitionAnimation(() => showGame());
    }

    async function showGame() {
      authModal.classList.add('hidden');
      document.getElementById('username-display').textContent = currentUser.username;
      if (currentUser.id) fetchLeaderboard('solo');
      else document.getElementById('leaderboard-list').innerHTML = '<li id="lb-status">Sign in to view</li>';
      roomStage = 'browse';
      if (sb) await ensureLobbyChannel();
      showMpEntry();
    }

    document.getElementById('logout-btn').addEventListener('click', async () => {
      stopGameLoop();
      if (mpChannel) {
        try { await mpChannel.unsubscribe(); } catch(e) {}
        mpChannel = null;
      }
      multiplayerMode = false;
      roomId = null;
      roomStage = 'browse';
      isHost = false;
      clearCurrentMatchSnapshot();
      resetCombatState();
      if (typeof releaseMultiplayerSessionLock === 'function') {
        releaseMultiplayerSessionLock({ force: true });
      }
      await disconnectLobbyChannel();
      spectating = false;
      if (sb) await sb.auth.signOut();
      currentUser = null;
      showNothing();
      authMode               = 'login';
      authTitle.textContent  = 'Log In';
      authSubmit.textContent = 'Log In';
      authSubmit.disabled    = false;
      authUsername.value     = '';
      authPassword.value     = '';
      authError.textContent  = '';
      document.getElementById('auth-toggle').innerHTML =
        'No account? <span id="auth-toggle-link">Sign up</span>';
      setupToggle();
      authModal.classList.remove('hidden');
    });

    // ── Leaderboard ───────────────────────────────────────────
    function getGameMode() {
      if (multiplayerMode) return 'multiplayer';
      if (partyMode)       return 'party';
      return 'solo';
    }

    async function fetchLeaderboard(mode) {
      mode = mode || getGameMode();
      const list = document.getElementById('leaderboard-list');
      const title = document.querySelector('#lb-panel h3');
      if (title) title.textContent = { solo: 'Solo', multiplayer: 'Multiplayer', party: 'Party Mode' }[mode] + ' Leaderboard';
      if (!sb) { list.innerHTML = '<li id="lb-status">Sign in to view</li>'; return; }
      list.innerHTML = '<li id="lb-status">Loading…</li>';

      const { data, error } = await sb
        .from('leaderboard')
        .select('username, best_score')
        .eq('mode', mode);

      list.innerHTML = '';

      if (error || !data || data.length === 0) {
        list.innerHTML = '<li id="lb-status">No scores yet!</li>';
        return;
      }

      data.forEach((entry, i) => {
        const li  = document.createElement('li');
        const isMe = currentUser && entry.username === currentUser.username;
        if (isMe) li.classList.add('me');
        li.innerHTML = `
          <span class="lb-rank">${i + 1}</span>
          <span class="lb-name">${escHtml(entry.username)}</span>
          <span class="lb-score">${entry.best_score}</span>
        `;
        list.appendChild(li);
      });
    }

    async function submitScore(score) {
      if (!currentUser || !currentUser.id || !sb) return;
      const mode = getGameMode();
      const { error } = await sb.from('scores').insert({
        user_id:  currentUser.id,
        username: currentUser.username,
        score,
        mode,
      });
      if (!error) await fetchLeaderboard(mode);
    }

    function escHtml(str) {
      return str.replace(/[&<>"']/g, c =>
        ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])
      );
    }

    // ── Session Restore ───────────────────────────────────────
    async function bootAuth() {
      if (!sb) return;
      const { data: { session } } = await sb.auth.getSession();
      if (session) {
        currentUser = {
          id:       session.user.id,
          username: session.user.user_metadata?.username || 'Player',
        };
        await showGame();
      }
    }
