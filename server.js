const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 10e6 // 10MB for image uploads
});

// Multer setup - store in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per file
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed'));
  }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ==================== GAME STATE ====================
const rooms = new Map();

function createRoom(hostId) {
  const roomId = uuidv4().slice(0, 8);
  rooms.set(roomId, {
    id: roomId,
    hostId: hostId,
    hostSocketId: null,
    images: [],           // [{ data: base64, name: string, answer: string }]
    players: new Map(),   // socketId -> { id, name, score, answers: [] }
    settings: {
      roundTime: 30,      // seconds
      totalRounds: 5
    },
    state: 'setup',       // setup | lobby | playing | roundResult | finished
    currentRound: 0,
    roundStartTime: null,
    roundTimer: null,
    roundAnswered: new Set(), // socketIds who answered correctly this round
    createdAt: Date.now()
  });
  return roomId;
}

// Cleanup old rooms (older than 3 hours)
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.createdAt > 3 * 60 * 60 * 1000) {
      if (room.roundTimer) clearTimeout(room.roundTimer);
      rooms.delete(id);
    }
  }
}, 60 * 1000);

// ==================== REST ENDPOINTS ====================

// Create a new room
app.post('/api/create-room', (req, res) => {
  const hostId = uuidv4().slice(0, 12);
  const roomId = createRoom(hostId);
  res.json({ roomId, hostId });
});

// Upload images to a room
app.post('/api/upload/:roomId', upload.array('images', 20), (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const answers = JSON.parse(req.body.answers || '[]');

  req.files.forEach((file, i) => {
    const base64 = file.buffer.toString('base64');
    const dataUrl = `data:${file.mimetype};base64,${base64}`;
    room.images.push({
      data: dataUrl,
      name: file.originalname,
      answer: answers[i] || 'Unknown'
    });
  });

  res.json({ count: room.images.length, images: room.images.map((img, i) => ({ index: i, name: img.name, answer: img.answer })) });
});

// Update room settings
app.post('/api/settings/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const { roundTime, totalRounds } = req.body;
  if (roundTime) room.settings.roundTime = parseInt(roundTime);
  if (totalRounds) room.settings.totalRounds = parseInt(totalRounds);

  res.json({ settings: room.settings });
});

// Delete an image from room
app.delete('/api/image/:roomId/:index', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const index = parseInt(req.params.index);
  if (index >= 0 && index < room.images.length) {
    room.images.splice(index, 1);
  }
  res.json({ count: room.images.length });
});

// Get room info (for join page)
app.get('/api/room/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  res.json({
    id: room.id,
    state: room.state,
    playerCount: room.players.size,
    settings: room.settings,
    imageCount: room.images.length
  });
});

// Serve game page for room links
app.get('/play/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

// ==================== SOCKET.IO EVENTS ====================

io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  // Host joins their room
  socket.on('host-join', ({ roomId, hostId }) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== hostId) {
      socket.emit('error-msg', { message: 'Invalid room or host ID' });
      return;
    }
    room.hostSocketId = socket.id;
    socket.join(roomId);
    socket.roomId = roomId;
    socket.isHost = true;
    room.state = 'lobby';

    socket.emit('room-joined', {
      roomId,
      isHost: true,
      settings: room.settings,
      imageCount: room.images.length,
      players: getPlayerList(room)
    });

    console.log(`Host joined room ${roomId}`);
  });

  // Player joins a room
  socket.on('player-join', ({ roomId, playerName }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error-msg', { message: 'Room not found' });
      return;
    }

    if (room.state === 'finished') {
      socket.emit('error-msg', { message: 'This game has already ended' });
      return;
    }

    if (room.state === 'setup') {
      socket.emit('error-msg', { message: 'Room is still being set up. Wait for the host to share the link.' });
      return;
    }

    const player = {
      id: socket.id,
      name: playerName.trim().slice(0, 20),
      score: 0,
      answers: [],
      streak: 0
    };

    room.players.set(socket.id, player);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.isHost = false;

    socket.emit('room-joined', {
      roomId,
      isHost: false,
      playerName: player.name,
      state: room.state,
      settings: room.settings,
      players: getPlayerList(room)
    });

    // Notify everyone
    io.to(roomId).emit('player-update', {
      players: getPlayerList(room),
      message: `${player.name} joined the game!`
    });

    // If game is in progress, send current round info
    if (room.state === 'playing') {
      const elapsed = Date.now() - room.roundStartTime;
      const remaining = Math.max(0, room.settings.roundTime * 1000 - elapsed);
      socket.emit('round-start', {
        round: room.currentRound,
        totalRounds: room.settings.totalRounds,
        image: room.images[room.currentRound - 1].data,
        timeRemaining: remaining,
        totalTime: room.settings.roundTime * 1000,
        hint: getHint(room.images[room.currentRound - 1].answer, elapsed, room.settings.roundTime * 1000)
      });
    }

    console.log(`Player "${player.name}" joined room ${roomId}`);
  });

  // Host starts the game
  socket.on('start-game', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || !socket.isHost) return;

    if (room.images.length === 0) {
      socket.emit('error-msg', { message: 'No images uploaded! Add some images first.' });
      return;
    }

    // Adjust total rounds to available images
    room.settings.totalRounds = Math.min(room.settings.totalRounds, room.images.length);
    room.currentRound = 0;
    room.state = 'playing';

    // Reset all scores
    for (const player of room.players.values()) {
      player.score = 0;
      player.answers = [];
      player.streak = 0;
    }

    io.to(roomId).emit('game-started', {
      totalRounds: room.settings.totalRounds,
      roundTime: room.settings.roundTime,
      playerCount: room.players.size
    });

    // Start first round after a short delay
    setTimeout(() => startRound(room), 2000);
  });

  // Player submits a guess
  socket.on('submit-guess', ({ roomId, guess }) => {
    const room = rooms.get(roomId);
    if (!room || room.state !== 'playing') return;

    const player = room.players.get(socket.id);
    if (!player) return;

    // Already answered correctly this round
    if (room.roundAnswered.has(socket.id)) {
      socket.emit('guess-result', { correct: true, alreadyAnswered: true });
      return;
    }

    const currentImage = room.images[room.currentRound - 1];
    const matchQuality = checkAnswer(guess, currentImage.answer); // 0 to 1.0
    const elapsed = Date.now() - room.roundStartTime;
    const totalTime = room.settings.roundTime * 1000;

    if (matchQuality > 0) {
      // Time-based scoring: faster = more points
      const timeRatio = elapsed / totalTime;
      let basePoints = Math.round(1000 - (timeRatio * 900));
      basePoints = Math.max(100, Math.min(1000, basePoints));

      // Apply match quality multiplier
      let points = Math.round(basePoints * matchQuality);

      // Determine match type for UI feedback
      let matchType = 'exact';     // 1.0
      if (matchQuality < 1.0 && matchQuality >= 0.7) matchType = 'close';
      else if (matchQuality < 0.7) matchType = 'partial';

      // Streak bonus (only for close+ matches)
      if (matchQuality >= 0.7) {
        player.streak++;
        if (player.streak >= 3) {
          points += 200;
        } else if (player.streak >= 2) {
          points += 100;
        }
      }

      // Position bonus (first correct gets extra, only for close+ matches)
      const position = room.roundAnswered.size + 1;
      if (matchQuality >= 0.7) {
        if (position === 1) points += 300;
        else if (position === 2) points += 150;
        else if (position === 3) points += 50;
      }

      player.score += points;
      player.answers.push({ round: room.currentRound, correct: true, points, time: elapsed, matchQuality });
      room.roundAnswered.add(socket.id);

      socket.emit('guess-result', {
        correct: true,
        points,
        totalScore: player.score,
        position,
        streak: player.streak,
        timeTaken: elapsed,
        matchType,
        matchQuality: Math.round(matchQuality * 100)
      });

      // Update leaderboard for everyone
      io.to(roomId).emit('leaderboard-update', {
        players: getPlayerList(room),
        answeredCount: room.roundAnswered.size,
        totalPlayers: room.players.size
      });
    } else {
      socket.emit('guess-result', { correct: false, guess });
    }
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    if (!socket.roomId) return;
    const room = rooms.get(socket.roomId);
    if (!room) return;

    if (socket.isHost) {
      // Host left - notify players but keep room alive for a while
      io.to(socket.roomId).emit('host-disconnected');
    } else {
      const player = room.players.get(socket.id);
      room.players.delete(socket.id);
      if (player) {
        io.to(socket.roomId).emit('player-update', {
          players: getPlayerList(room),
          message: `${player.name} left the game`
        });
      }
    }

    console.log(`Disconnected: ${socket.id}`);
  });
});

// ==================== GAME LOGIC ====================

function startRound(room) {
  room.currentRound++;
  if (room.currentRound > room.settings.totalRounds) {
    endGame(room);
    return;
  }

  room.state = 'playing';
  room.roundStartTime = Date.now();
  room.roundAnswered = new Set();

  const currentImage = room.images[room.currentRound - 1];

  io.to(room.id).emit('round-start', {
    round: room.currentRound,
    totalRounds: room.settings.totalRounds,
    image: currentImage.data,
    timeRemaining: room.settings.roundTime * 1000,
    totalTime: room.settings.roundTime * 1000,
    answerLength: currentImage.answer.length,
    wordCount: currentImage.answer.split(/\s+/).length
  });

  // Send hints at intervals
  let hintSent = { firstLetter: false, wordCount: false };
  const hintInterval = setInterval(() => {
    if (room.state !== 'playing') {
      clearInterval(hintInterval);
      return;
    }
    const elapsed = Date.now() - room.roundStartTime;
    const totalTime = room.settings.roundTime * 1000;

    if (elapsed >= totalTime * 0.5 && !hintSent.firstLetter) {
      hintSent.firstLetter = true;
      io.to(room.id).emit('hint', {
        type: 'first-letter',
        value: currentImage.answer.charAt(0).toUpperCase(),
        message: `Hint: Starts with "${currentImage.answer.charAt(0).toUpperCase()}"`
      });
    }

    if (elapsed >= totalTime * 0.75 && !hintSent.wordCount) {
      hintSent.wordCount = true;
      const wordCount = currentImage.answer.split(/\s+/).length;
      io.to(room.id).emit('hint', {
        type: 'word-count',
        value: wordCount,
        message: `Hint: ${wordCount} word${wordCount > 1 ? 's' : ''}`
      });
      clearInterval(hintInterval);
    }
  }, 1000);

  // End round timer
  room.roundTimer = setTimeout(() => {
    clearInterval(hintInterval);
    endRound(room);
  }, room.settings.roundTime * 1000);
}

function endRound(room) {
  room.state = 'roundResult';
  const currentImage = room.images[room.currentRound - 1];

  // Mark streak broken for players who didn't answer
  for (const [socketId, player] of room.players) {
    if (!room.roundAnswered.has(socketId)) {
      player.streak = 0;
      player.answers.push({ round: room.currentRound, correct: false, points: 0, time: null });
    }
  }

  io.to(room.id).emit('round-end', {
    round: room.currentRound,
    totalRounds: room.settings.totalRounds,
    correctAnswer: currentImage.answer,
    image: currentImage.data,
    players: getPlayerList(room),
    answeredCount: room.roundAnswered.size,
    totalPlayers: room.players.size
  });

  // Auto-advance to next round after 5 seconds
  room.roundTimer = setTimeout(() => {
    startRound(room);
  }, 5000);
}

function endGame(room) {
  room.state = 'finished';
  if (room.roundTimer) clearTimeout(room.roundTimer);

  const players = getPlayerList(room);
  players.sort((a, b) => b.score - a.score);

  io.to(room.id).emit('game-over', {
    players,
    winner: players[0] || null,
    totalRounds: room.settings.totalRounds
  });
}

function getPlayerList(room) {
  const players = [];
  for (const player of room.players.values()) {
    players.push({
      id: player.id,
      name: player.name,
      score: player.score,
      streak: player.streak,
      correctAnswers: player.answers.filter(a => a.correct).length
    });
  }
  return players.sort((a, b) => b.score - a.score);
}

function checkAnswer(guess, correctAnswer) {
  if (!guess || !correctAnswer) return 0;

  const normalize = (str) => str.toLowerCase().trim()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ');

  const g = normalize(guess);
  const c = normalize(correctAnswer);
  if (!g || !c) return 0;

  // Exact match → 1.0
  if (g === c) return 1.0;

  // Full contains match → 0.9-1.0
  if (g.includes(c)) return 1.0;
  if (c.includes(g) && g.length >= c.length * 0.7) return 0.9;

  // Levenshtein on full string
  const distance = levenshtein(g, c);
  const maxLen = Math.max(g.length, c.length);
  const ratio = maxLen > 0 ? distance / maxLen : 1;

  // Very close (<=15% typos) → 0.9
  if (ratio <= 0.15) return 0.9;
  // Close (<=25% typos) → 0.8
  if (ratio <= 0.25) return 0.8;
  // Somewhat close (<=35% typos) → 0.7
  if (ratio <= 0.35) return 0.7;

  // Strip common words and compare
  const stopWords = ['the', 'of', 'a', 'an', 'at', 'in', 'on', 'le', 'la', 'el', 'de', 'di', 'du'];
  const stripStop = (str) => str.split(' ').filter(w => !stopWords.includes(w)).join(' ');
  const gStripped = stripStop(g);
  const cStripped = stripStop(c);
  if (gStripped && cStripped) {
    if (gStripped === cStripped) return 0.95;
    const dStripped = levenshtein(gStripped, cStripped);
    const maxStripped = Math.max(gStripped.length, cStripped.length);
    const sRatio = maxStripped > 0 ? dStripped / maxStripped : 1;
    if (sRatio <= 0.2) return 0.85;
    if (sRatio <= 0.35) return 0.7;
  }

  // Word-by-word matching for partial credit
  const gWords = g.split(' ').filter(w => w.length > 2);
  const cWords = c.split(' ').filter(w => w.length > 2 && !stopWords.includes(w));
  if (cWords.length > 0 && gWords.length > 0) {
    let matchedWords = 0;
    for (const cw of cWords) {
      for (const gw of gWords) {
        const wordDist = levenshtein(gw, cw);
        const wordMax = Math.max(gw.length, cw.length);
        if (wordMax > 0 && wordDist / wordMax <= 0.3) {
          matchedWords++;
          break;
        }
      }
    }
    const wordRatio = matchedWords / cWords.length;
    // All key words match → 0.85
    if (wordRatio >= 1.0) return 0.85;
    // Most key words match → 0.6
    if (wordRatio >= 0.6) return 0.6;
    // Some key words match → partial credit
    if (wordRatio >= 0.4) return 0.4;
  }

  // Partial contain match (shorter threshold) → 0.4
  if (c.includes(g) && g.length >= c.length * 0.4) return 0.4;

  // Vowel-stripped comparison → 0.65
  const stripVowels = (str) => str.replace(/[aeiou]/g, '');
  const gNoVowels = stripVowels(g);
  const cNoVowels = stripVowels(c);
  if (gNoVowels.length >= 3 && cNoVowels.length >= 3) {
    const vDist = levenshtein(gNoVowels, cNoVowels);
    const vMax = Math.max(gNoVowels.length, cNoVowels.length);
    if (vMax > 0 && vDist / vMax <= 0.2) return 0.65;
  }

  return 0;
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function getHint(answer, elapsed, totalTime) {
  const hints = [];
  if (elapsed >= totalTime * 0.5) {
    hints.push({ type: 'first-letter', value: answer.charAt(0).toUpperCase() });
  }
  if (elapsed >= totalTime * 0.75) {
    hints.push({ type: 'word-count', value: answer.split(/\s+/).length });
  }
  return hints;
}

// ==================== START SERVER ====================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌍 Guess the Place server running on port ${PORT}`);
  console.log(`   Open http://localhost:${PORT} to play!`);
});
