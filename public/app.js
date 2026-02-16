// ==================== GLOBALS ====================
const socket = io();
let roomId = null;
let isHost = false;
let playerName = '';
let timerInterval = null;
let currentHints = [];

// ==================== INIT ====================
(function init() {
    // Extract room ID from URL: /play/:roomId
    const pathParts = window.location.pathname.split('/');
    roomId = pathParts[pathParts.length - 1];

    // Check if host
    const params = new URLSearchParams(window.location.search);
    const hostId = params.get('host');

    if (hostId) {
        isHost = true;
        // Host auto-joins
        socket.emit('host-join', { roomId, hostId });
        document.getElementById('navBadge').innerHTML = '<span class="badge badge-purple">🎯 Host</span>';
    }

    // Enter key for name input
    document.getElementById('playerNameInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') joinGame();
    });

    // Enter key for guess input
    document.getElementById('guessInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitGuess();
    });
})();

// ==================== SCREEN MANAGEMENT ====================
function showScreen(screenId) {
    document.querySelectorAll('.game-screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
}

// ==================== JOIN GAME ====================
function joinGame() {
    playerName = document.getElementById('playerNameInput').value.trim();
    if (!playerName) {
        showError('Please enter your name!');
        return;
    }
    if (playerName.length < 2) {
        showError('Name must be at least 2 characters!');
        return;
    }

    document.getElementById('joinBtn').disabled = true;
    document.getElementById('joinBtn').textContent = '⏳ Joining...';

    socket.emit('player-join', { roomId, playerName });
}

function showError(msg) {
    const el = document.getElementById('joinError');
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(() => el.style.display = 'none', 3000);
}

// ==================== SOCKET EVENTS ====================

// Successfully joined
socket.on('room-joined', (data) => {
    isHost = data.isHost;
    showScreen('lobbyScreen');
    updateLobby(data.players);

    if (isHost) {
        document.getElementById('hostControls').classList.remove('hidden');
        document.getElementById('playerWaiting').classList.add('hidden');
        document.getElementById('hostShareSection').classList.remove('hidden');
        document.getElementById('lobbyShareLink').value = `${window.location.origin}/play/${roomId}`;
        document.getElementById('lobbySubtitle').textContent = 'Share the link and start when ready!';
        document.getElementById('navBadge').innerHTML = '<span class="badge badge-purple">🎯 Host</span>';
    }

    // If game is already in progress (late joiner)
    if (data.state === 'playing') {
        showScreen('playingScreen');
    }
});

// Player update
socket.on('player-update', (data) => {
    updateLobby(data.players);
    if (data.message) {
        showToast(data.message, 'info');
    }
});

// Game started
socket.on('game-started', (data) => {
    showScreen('countdownScreen');
    document.getElementById('gameInfo').textContent =
        `${data.totalRounds} rounds • ${data.roundTime}s each • ${data.playerCount} players`;

    // Countdown animation
    let count = 3;
    document.getElementById('countdownNumber').textContent = count;
    const countInterval = setInterval(() => {
        count--;
        if (count > 0) {
            document.getElementById('countdownNumber').textContent = count;
        } else {
            clearInterval(countInterval);
            document.getElementById('countdownNumber').textContent = 'GO!';
        }
    }, 700);
});

// Round started
socket.on('round-start', (data) => {
    showScreen('playingScreen');
    currentHints = [];

    document.getElementById('currentRound').textContent = data.round;
    document.getElementById('totalRounds').textContent = data.totalRounds;
    document.getElementById('gameImage').src = data.image;
    document.getElementById('answeredCount').textContent = '0';
    document.getElementById('totalPlayers').textContent = '0';

    // Reset answer input
    document.getElementById('guessInput').value = '';
    document.getElementById('guessInput').disabled = false;
    document.getElementById('submitGuessBtn').disabled = false;
    document.getElementById('answerSection').classList.remove('hidden');
    document.getElementById('answeredCorrectly').classList.add('hidden');
    document.getElementById('hintsContainer').innerHTML = '';

    // Start timer
    startTimer(data.timeRemaining, data.totalTime);

    // Focus on input
    setTimeout(() => document.getElementById('guessInput').focus(), 300);
});

// Hint received
socket.on('hint', (data) => {
    if (currentHints.find(h => h.type === data.type)) return; // Skip duplicate hints
    currentHints.push(data);

    const container = document.getElementById('hintsContainer');
    const badge = document.createElement('div');
    badge.className = 'hint-badge';
    badge.innerHTML = `💡 ${data.message}`;
    container.appendChild(badge);
});

// Guess result
socket.on('guess-result', (data) => {
    if (data.alreadyAnswered) return;

    if (data.correct) {
        // Show success feedback
        showFeedback('correct', `+${data.points} points!`);
        showScorePopup(data.points, data.streak, data.position);

        // Disable input
        document.getElementById('guessInput').disabled = true;
        document.getElementById('submitGuessBtn').disabled = true;
        document.getElementById('answerSection').classList.add('hidden');
        document.getElementById('answeredCorrectly').classList.remove('hidden');

        if (data.streak >= 2) {
            const el = document.getElementById('answeredCorrectly');
            el.innerHTML = `✅ Correct! +${data.points} pts ${data.streak >= 3 ? '🔥🔥🔥' : '🔥'} ${data.streak} streak!`;
        }
    } else {
        showFeedback('incorrect', 'Wrong! Try again');
        // Shake input
        const input = document.getElementById('guessInput');
        input.style.animation = 'shake 0.4s ease';
        setTimeout(() => input.style.animation = '', 400);
        input.value = '';
        input.focus();
    }
});

// Leaderboard update during round
socket.on('leaderboard-update', (data) => {
    renderMiniLeaderboard(data.players);
    document.getElementById('answeredCount').textContent = data.answeredCount;
    document.getElementById('totalPlayers').textContent = data.totalPlayers;
});

// Round ended
socket.on('round-end', (data) => {
    if (timerInterval) clearInterval(timerInterval);
    showScreen('roundResultScreen');

    document.getElementById('resultRound').textContent = data.round;
    document.getElementById('resultTotalRounds').textContent = data.totalRounds;
    document.getElementById('resultImage').src = data.image;
    document.getElementById('revealAnswer').textContent = data.correctAnswer;
    document.getElementById('resultCorrectCount').textContent = data.answeredCount;
    document.getElementById('resultTotalCount').textContent = data.totalPlayers;

    renderLeaderboard(data.players, 'roundResultLeaderboard');
});

// Game over
socket.on('game-over', (data) => {
    if (timerInterval) clearInterval(timerInterval);
    showScreen('finalScreen');

    if (data.winner) {
        document.getElementById('winnerAnnouncement').textContent =
            `🎉 ${data.winner.name} wins with ${data.winner.score} points!`;
    }

    renderPodium(data.players);
    renderLeaderboard(data.players, 'fullLeaderboardList');

    // Confetti!
    launchConfetti();
});

// Error
socket.on('error-msg', (data) => {
    showToast(data.message, 'warning');
    showError(data.message);
    document.getElementById('joinBtn').disabled = false;
    document.getElementById('joinBtn').textContent = '🎮 Join Game';
});

// Host disconnected
socket.on('host-disconnected', () => {
    showToast('Host disconnected! The game may end soon.', 'warning');
});

// ==================== GAME ACTIONS ====================
function submitGuess() {
    const guess = document.getElementById('guessInput').value.trim();
    if (!guess) return;

    socket.emit('submit-guess', { roomId, guess });
}

function startGame() {
    const btn = document.getElementById('startGameBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Starting...';
    socket.emit('start-game', { roomId });
}

function copyLink() {
    const link = document.getElementById('lobbyShareLink').value;
    navigator.clipboard.writeText(link).then(() => {
        showToast('Link copied! Share it with your friends.', 'success');
    });
}

// ==================== TIMER ====================
function startTimer(duration, totalTime) {
    if (timerInterval) clearInterval(timerInterval);

    const bar = document.getElementById('timerBar');
    const timeText = document.getElementById('timeLeft');
    const startTime = Date.now();
    const endTime = startTime + duration;

    timerInterval = setInterval(() => {
        const now = Date.now();
        const remaining = Math.max(0, endTime - now);
        const fraction = remaining / totalTime;

        bar.style.width = `${fraction * 100}%`;

        if (fraction < 0.25) {
            bar.classList.add('warning');
            timeText.classList.add('urgent');
        } else {
            bar.classList.remove('warning');
            timeText.classList.remove('urgent');
        }

        const seconds = Math.ceil(remaining / 1000);
        timeText.textContent = `${seconds}s`;

        if (remaining <= 0) {
            clearInterval(timerInterval);
            timeText.textContent = '0s';
            bar.style.width = '0%';
        }
    }, 50);
}

// ==================== LOBBY UI ====================
function updateLobby(players) {
    const grid = document.getElementById('playersGrid');
    const avatars = ['🧑', '👩', '🧔', '👱', '🧑‍🦰', '👩‍🦱', '🧑‍🦳', '👲', '🧕', '🤠', '🥷', '🦸', '🧙', '🧑‍🚀', '🎅'];

    grid.innerHTML = players.map((p, i) => `
    <div class="player-chip">
      <div class="avatar">${avatars[i % avatars.length]}</div>
      <span>${escapeHtml(p.name)}</span>
    </div>
  `).join('');

    document.getElementById('playerCountDisplay').textContent = players.length;
}

// ==================== LEADERBOARD UI ====================
function renderMiniLeaderboard(players) {
    renderLeaderboard(players.slice(0, 5), 'miniLeaderboardList');
}

function renderLeaderboard(players, containerId) {
    const container = document.getElementById(containerId);
    const medals = ['🥇', '🥈', '🥉'];

    container.innerHTML = players.map((p, i) => `
    <div class="leaderboard-item" style="--i:${i}">
      <div class="leaderboard-rank">${medals[i] || (i + 1)}</div>
      <div class="leaderboard-name">${escapeHtml(p.name)} ${p.streak >= 3 ? '<span class="streak-badge">🔥 ' + p.streak + '</span>' : ''}</div>
      <div class="leaderboard-correct">${p.correctAnswers || 0}✅</div>
      <div class="leaderboard-score">${p.score.toLocaleString()}</div>
    </div>
  `).join('');
}

// ==================== PODIUM ====================
function renderPodium(players) {
    const container = document.getElementById('podiumContainer');
    const top3 = players.slice(0, 3);
    const emojis = ['👑', '⭐', '🌟'];

    // Reorder for podium: 2nd, 1st, 3rd
    const podiumOrder = [];
    if (top3[1]) podiumOrder.push({ ...top3[1], place: 2 });
    if (top3[0]) podiumOrder.push({ ...top3[0], place: 1 });
    if (top3[2]) podiumOrder.push({ ...top3[2], place: 3 });

    container.innerHTML = podiumOrder.map(p => `
    <div class="podium-place" style="order:${p.place === 1 ? 1 : p.place === 2 ? 0 : 2}">
      <div class="podium-avatar">${emojis[p.place - 1]}</div>
      <div class="podium-name">${escapeHtml(p.name)}</div>
      <div class="podium-score">${p.score.toLocaleString()} pts</div>
      <div class="podium-bar">#${p.place}</div>
    </div>
  `).join('');
}

// ==================== VISUAL FEEDBACK ====================
function showFeedback(type, text) {
    const el = document.createElement('div');
    el.className = `guess-feedback ${type}`;
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1500);
}

function showScorePopup(points, streak, position) {
    const el = document.createElement('div');
    el.className = 'score-popup';
    el.innerHTML = `
    <div class="points">+${points}</div>
    ${position === 1 ? '<div class="bonus-text">🥇 First to answer!</div>' : ''}
    ${streak >= 3 ? '<div class="bonus-text">🔥 ' + streak + ' streak bonus!</div>' : (streak >= 2 ? '<div class="bonus-text">🔥 Streak!</div>' : '')}
  `;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2000);
}

// ==================== CONFETTI ====================
function launchConfetti() {
    const colors = ['#7c3aed', '#06b6d4', '#f59e0b', '#10b981', '#ef4444', '#ec4899', '#fbbf24'];
    for (let i = 0; i < 80; i++) {
        const piece = document.createElement('div');
        piece.className = 'confetti-piece';
        piece.style.left = Math.random() * 100 + 'vw';
        piece.style.width = (Math.random() * 10 + 5) + 'px';
        piece.style.height = (Math.random() * 10 + 5) + 'px';
        piece.style.background = colors[Math.floor(Math.random() * colors.length)];
        piece.style.borderRadius = Math.random() > 0.5 ? '50%' : '0';
        piece.style.animationDuration = (Math.random() * 2 + 2) + 's';
        piece.style.animationDelay = Math.random() * 1.5 + 's';
        document.body.appendChild(piece);
        setTimeout(() => piece.remove(), 5000);
    }
}

// ==================== TOASTS ====================
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

// ==================== UTILS ====================
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
