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
      await showGame();
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

    async function playAsGuest() {
      currentUser = { id: null, username: getGuestUsername() };
      await showGame();
    }

    async function showGame() {
      authModal.classList.add('hidden');
      document.getElementById('username-display').textContent = currentUser.username;
      setLeaderboardMode('multiplayer');
      if (currentUser.id) fetchLeaderboard('multiplayer');
      else renderLeaderboardAuthState();
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

    const LEADERBOARD_MODES = {
      multiplayer: 'Multiplayer',
      solo: 'Solo',
      party: 'Party Mode',
    };
    const LEADERBOARD_PAGE_SIZE = 20;
    const LEADERBOARD_MAX_RANK = 100;
    const leaderboardState = {
      mode: 'multiplayer',
      offset: 0,
      hasNextPage: false,
      totalCount: 0,
    };

    function getLeaderboardListEl() {
      return document.getElementById('leaderboard-list');
    }

    function getLeaderboardPageBtn() {
      return document.getElementById('leaderboard-page-btn');
    }

    function isElementVisible(element) {
      if (!element) return false;
      return element.style.display !== 'none' && element.offsetParent !== null;
    }

    function syncLeaderboardPanelHeight() {
      const panel = document.getElementById('lb-panel');
      if (!panel) return;

      const reference = [
        document.getElementById('canvas-wrap'),
        document.getElementById('mp-entry'),
        document.getElementById('mp-lobby'),
      ].find(isElementVisible);

      if (!reference) {
        panel.style.setProperty('--leaderboard-max-height', '600px');
        return;
      }

      const panelRect = panel.getBoundingClientRect();
      const referenceRect = reference.getBoundingClientRect();
      const availableHeight = Math.floor(referenceRect.bottom - panelRect.top);
      const maxHeight = Math.min(referenceRect.height, Math.max(180, availableHeight));
      panel.style.setProperty('--leaderboard-max-height', `${Math.round(maxHeight)}px`);

      const list = getLeaderboardListEl();
      const title = panel.querySelector('h3');
      const tabs = document.getElementById('leaderboard-tabs');
      const pageButton = getLeaderboardPageBtn();
      if (!list || !title || !tabs || !pageButton) return;

      const panelStyle = getComputedStyle(panel);
      const titleStyle = getComputedStyle(title);
      const tabsStyle = getComputedStyle(tabs);
      const buttonStyle = getComputedStyle(pageButton);
      const reservedHeight =
        parseFloat(panelStyle.paddingTop) +
        parseFloat(panelStyle.paddingBottom) +
        title.offsetHeight +
        parseFloat(titleStyle.marginBottom) +
        tabs.offsetHeight +
        parseFloat(tabsStyle.marginBottom) +
        pageButton.offsetHeight +
        parseFloat(buttonStyle.marginTop);
      const listHeight = Math.max(48, Math.floor(maxHeight - reservedHeight));
      panel.style.setProperty('--leaderboard-list-max-height', `${listHeight}px`);
    }

    function updateLeaderboardTabs() {
      document.querySelectorAll('.lb-tab').forEach((button) => {
        const active = button.dataset.mode === leaderboardState.mode;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    }

    function updateLeaderboardTitle() {
      const title = document.querySelector('#lb-panel h3');
      if (title) title.textContent = `${LEADERBOARD_MODES[leaderboardState.mode]} Leaderboard`;
    }

    function updateLeaderboardPageButton(canPage = true) {
      const button = getLeaderboardPageBtn();
      if (!button) return;
      const targetOffset = leaderboardState.hasNextPage
        || (leaderboardState.offset === 0 && leaderboardState.totalCount > 0)
        ? leaderboardState.offset + LEADERBOARD_PAGE_SIZE
        : 0;
      const start = targetOffset + 1;
      const end = targetOffset + LEADERBOARD_PAGE_SIZE;
      button.textContent = `Ranks ${start}-${end}`;
      button.disabled = !canPage;
    }

    function renderLeaderboardAuthState() {
      const list = getLeaderboardListEl();
      if (list) list.innerHTML = '<li id="lb-status">Sign in to view</li>';
      updateLeaderboardTitle();
      updateLeaderboardTabs();
      updateLeaderboardPageButton(false);
      syncLeaderboardPanelHeight();
    }

    function setLeaderboardMode(mode, options = {}) {
      if (!LEADERBOARD_MODES[mode]) return;
      leaderboardState.mode = mode;
      if (!options.keepPage) {
        leaderboardState.offset = 0;
        leaderboardState.hasNextPage = false;
        leaderboardState.totalCount = 0;
      }
      updateLeaderboardTitle();
      updateLeaderboardTabs();
      updateLeaderboardPageButton();
      syncLeaderboardPanelHeight();
    }

    function syncLeaderboardToGameMode() {
      setLeaderboardMode(getGameMode());
      if (currentUser?.id) {
        void fetchLeaderboard();
      } else {
        renderLeaderboardAuthState();
      }
    }

    function cycleLeaderboardPage() {
      const button = getLeaderboardPageBtn();
      if (button?.disabled) return;
      leaderboardState.offset = leaderboardState.hasNextPage
        ? leaderboardState.offset + LEADERBOARD_PAGE_SIZE
        : 0;
      if (leaderboardState.offset >= LEADERBOARD_MAX_RANK) {
        leaderboardState.offset = 0;
      }
      void fetchLeaderboard(leaderboardState.mode, { keepPage: true });
    }

    document.querySelectorAll('.lb-tab').forEach((button) => {
      button.addEventListener('click', () => {
        setLeaderboardMode(button.dataset.mode);
        void fetchLeaderboard();
      });
    });

    const leaderboardPageButton = getLeaderboardPageBtn();
    if (leaderboardPageButton) {
      leaderboardPageButton.addEventListener('click', cycleLeaderboardPage);
    }
    window.addEventListener('resize', syncLeaderboardPanelHeight);

    function renderLeaderboardRows(entries) {
      const list = getLeaderboardListEl();
      if (!list) return;

      const existingRows = new Map(
        Array.from(list.querySelectorAll('li[data-leaderboard-key]')).map((row) => [
          row.dataset.leaderboardKey,
          row,
        ])
      );
      const nextKeys = new Set();

      entries.forEach((entry, i) => {
        const rank = leaderboardState.offset + i + 1;
        const key = entry.username;
        nextKeys.add(key);

        let li = existingRows.get(key);
        if (!li) {
          li = document.createElement('li');
          li.dataset.leaderboardKey = key;
          li.innerHTML = `
            <span class="lb-rank"></span>
            <span class="lb-name"></span>
            <span class="lb-score"></span>
          `;
        }

        li.className = '';
        if (currentUser && entry.username === currentUser.username) li.classList.add('me');
        if (rank <= 3) li.classList.add('top-three', `rank-${rank}`);

        const rankEl = li.querySelector('.lb-rank');
        const nameEl = li.querySelector('.lb-name');
        const scoreEl = li.querySelector('.lb-score');
        const nextRank = String(rank);
        const nextScore = String(entry.best_score);
        if (rankEl.textContent !== nextRank) rankEl.textContent = nextRank;
        if (nameEl.textContent !== entry.username) nameEl.textContent = entry.username;
        if (scoreEl.textContent !== nextScore) scoreEl.textContent = nextScore;

        list.appendChild(li);
      });

      existingRows.forEach((row, key) => {
        if (!nextKeys.has(key)) row.remove();
      });
      const status = list.querySelector('#lb-status');
      if (status) status.remove();
    }

    async function fetchLeaderboard(mode) {
      mode = mode || leaderboardState.mode || getGameMode();
      setLeaderboardMode(mode, { keepPage: true });
      const list = getLeaderboardListEl();
      if (!list) return;
      if (!sb || !currentUser?.id) { renderLeaderboardAuthState(); return; }
      if (!list.querySelector('li')) {
        list.innerHTML = '<li id="lb-status">Loading…</li>';
      }
      updateLeaderboardPageButton(false);

      const { data, error, count } = await sb
        .from('leaderboard')
        .select('username, best_score', { count: 'exact' })
        .eq('mode', mode)
        .order('best_score', { ascending: false })
        .range(leaderboardState.offset, leaderboardState.offset + LEADERBOARD_PAGE_SIZE - 1);

      if (error || !data || data.length === 0) {
        if (leaderboardState.offset > 0) {
          leaderboardState.offset = 0;
          leaderboardState.hasNextPage = false;
          leaderboardState.totalCount = 0;
          updateLeaderboardPageButton(false);
          void fetchLeaderboard(mode);
          return;
        }
        leaderboardState.hasNextPage = false;
        leaderboardState.totalCount = 0;
        list.innerHTML = '<li id="lb-status">No scores yet!</li>';
        updateLeaderboardPageButton(false);
        return;
      }

      leaderboardState.totalCount = typeof count === 'number'
        ? count
        : leaderboardState.offset + data.length;
      leaderboardState.hasNextPage = leaderboardState.offset + LEADERBOARD_PAGE_SIZE < leaderboardState.totalCount
        && leaderboardState.offset + LEADERBOARD_PAGE_SIZE < LEADERBOARD_MAX_RANK;

      renderLeaderboardRows(data);
      const canPage = leaderboardState.hasNextPage || leaderboardState.offset > 0;
      updateLeaderboardPageButton(canPage);
      syncLeaderboardPanelHeight();
    }

    async function submitScore(score, options = {}) {
      if (!currentUser || !currentUser.id || !sb) return;
      const { refreshLeaderboard = true } = options;
      const mode = getGameMode();
      const { error } = await sb.from('scores').insert({
        user_id:  currentUser.id,
        username: currentUser.username,
        score,
        mode,
      });
      if (!error && refreshLeaderboard) await fetchLeaderboard(mode);
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
