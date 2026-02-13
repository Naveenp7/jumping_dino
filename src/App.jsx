import React, { useEffect, useRef, useState, useCallback } from "react";
import { Pose, POSE_CONNECTIONS } from "@mediapipe/pose";
import { drawConnectors, drawLandmarks } from "@mediapipe/drawing_utils";
import { Camera } from "@mediapipe/camera_utils";
import DinoGame from "./components/DinoGame";
import { ref, push, onValue, query, orderByChild, limitToLast } from "firebase/database";
import { database } from "./firebase";
import "./App.css";

// ── localStorage helpers ──────────────────────────────────────────
const STORAGE_KEYS = {
  LEADERBOARD: "dino_leaderboard",
  SESSION_STATS: "dino_session_stats",
  STREAK: "dino_streak",
  THEME: "dino_theme",
};

function loadStored(key, fallback) {
  try {
    const item = localStorage.getItem(key);
    return item ? JSON.parse(item) : fallback;
  } catch {
    return fallback;
  }
}

function saveStored(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

// ── Format helpers ────────────────────────────────────────────────
function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s}s`;
}

function timeAgo(timestamp) {
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ══════════════════════════════════════════════════════════════════
const GAME_STATE = { START: 'START', PLAYING: 'PLAYING', GAME_OVER: 'GAME_OVER' };

const App = () => {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const prevShoulderRef = useRef(null);
  const lastJumpTimeRef = useRef(0);

  // Audio
  const audioContextRef = useRef(null);
  const jumpBufferRef = useRef(null);
  const gameOverBufferRef = useRef(null);

  // ── Stats refs ────────────────────────────────────────────────
  const jumpCountRef = useRef(0);
  const roundStartRef = useRef(Date.now());
  const handleGameOverRef = useRef(null);
  const playerNameRef = useRef(localStorage.getItem('dino_player_name') || '');
  const isGameActiveRef = useRef(false);

  // ── Player Name State ─────────────────────────────────────────
  const [playerName, setPlayerName] = useState(localStorage.getItem('dino_player_name') || '');
  // ── Game State ────────────────────────────────────────────────
  const [gameState, setGameState] = useState(GAME_STATE.START);
  const [inputName, setInputName] = useState(localStorage.getItem('dino_player_name') || '');

  // Sync ref with state just in case, though we will write to ref primarily
  useEffect(() => {
    playerNameRef.current = playerName;
  }, [playerName]);

  const handleNameSubmit = (e) => {
    e.preventDefault();
    if (inputName.trim()) {
      const name = inputName.trim().toUpperCase().slice(0, 10);
      setPlayerName(name);
      playerNameRef.current = name; // Update ref immediately
      localStorage.setItem('dino_player_name', name);

      setGameState(GAME_STATE.PLAYING);
      isGameActiveRef.current = true; // Game is active
      jumpCountRef.current = 0;
      roundStartRef.current = Date.now();
    }
  };

  const handleRetry = () => {
    setGameState(GAME_STATE.PLAYING);
    isGameActiveRef.current = true;
    jumpCountRef.current = 0;
    roundStartRef.current = Date.now();

    if (window.Runner && window.Runner.instance_) {
      window.Runner.instance_.restart();
    }
  };

  const handleMainMenu = () => {
    setGameState(GAME_STATE.START);
    setPlayerName('');
    playerNameRef.current = '';
    isGameActiveRef.current = false;
    localStorage.removeItem('dino_player_name');
    setInputName('');
  };

  // ── React state ───────────────────────────────────────────────
  const [leaderboard, setLeaderboard] = useState(() =>
    loadStored(STORAGE_KEYS.LEADERBOARD, [])
  );
  const [sessionStats, setSessionStats] = useState(() =>
    loadStored(STORAGE_KEYS.SESSION_STATS, {
      totalJumps: 0,
      totalPlayTime: 0,
      totalScore: 0,
      roundsPlayed: 0,
    })
  );
  const [streak, setStreak] = useState(() =>
    loadStored(STORAGE_KEYS.STREAK, { current: 0, best: 0, lastScore: 0 })
  );
  const [theme, setTheme] = useState(() =>
    loadStored(STORAGE_KEYS.THEME, "dark")
  );

  const [lastGameScore, setLastGameScore] = useState(null);
  const [newHighlight, setNewHighlight] = useState(-1);

  // ── Theme toggle ──────────────────────────────────────────────
  const toggleTheme = () => {
    const newTheme = theme === "dark" ? "light" : "dark";
    setTheme(newTheme);
    saveStored(STORAGE_KEYS.THEME, newTheme);
  };

  // ── Handle game over ──────────────────────────────────────────
  const handleGameOver = useCallback(() => {
    // Only run if the game was considered active
    if (!isGameActiveRef.current) return;

    // Mark as inactive immediately to prevent duplicates
    isGameActiveRef.current = false;

    let score = 0;
    try {
      const digits = window.Runner.instance_.distanceMeter.digits;
      score = parseInt(digits.join(""), 10) || 0;
    } catch {
      score = 0;
    }

    setLastGameScore(score);

    const roundTime = (Date.now() - roundStartRef.current) / 1000;
    const jumps = jumpCountRef.current;
    const currentPlayer = playerNameRef.current; // Use Ref for latest name

    console.log(`[GameOver] Saving score for ${currentPlayer}: ${score}`);

    // Push score to Firebase
    if (currentPlayer) {
      push(ref(database, 'leaderboard'), {
        name: currentPlayer,
        score,
        timestamp: Date.now(),
        jumps,
        time: Math.round(roundTime),
        gameMode: "arcade"
      }).then(() => console.log("Score saved to Firebase"))
        .catch(e => console.error("Firebase save error:", e));
    }

    // Update local session stats (personal only)
    setSessionStats((prev) => {
      const updated = {
        totalJumps: prev.totalJumps + jumps,
        totalPlayTime: prev.totalPlayTime + roundTime,
        totalScore: prev.totalScore + score,
        roundsPlayed: prev.roundsPlayed + 1,
      };
      saveStored(STORAGE_KEYS.SESSION_STATS, updated);
      return updated;
    });

    setStreak((prev) => {
      let newStreak;
      if (prev.lastScore === 0 || score > prev.lastScore) {
        const current = prev.current + 1;
        newStreak = {
          current,
          best: Math.max(prev.best, current),
          lastScore: score,
        };
      } else {
        newStreak = { current: 0, best: prev.best, lastScore: score };
      }
      saveStored(STORAGE_KEYS.STREAK, newStreak);
      return newStreak;
    });

    // We don't reset refs here; we reset them ON START/RETRY
    setGameState(GAME_STATE.GAME_OVER);
  }, []); // No dependencies needed as we use Refs

  // Keep ref strictly updated
  useEffect(() => {
    handleGameOverRef.current = handleGameOver;
  }, [handleGameOver]);

  // ── Firebase Leaderboard Listener ─────────────────────────────
  useEffect(() => {
    const scoresRef = query(
      ref(database, "leaderboard"),
      orderByChild("score"),
      limitToLast(10)
    );

    const unsubscribe = onValue(scoresRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        // Convert object to array and sort descending
        const parsed = Object.values(data).sort((a, b) => b.score - a.score);
        setLeaderboard(parsed);
      } else {
        setLeaderboard([]);
      }
    });

    return () => unsubscribe();
  }, []);

  const handleCrash = useCallback(() => {
    playSound(gameOverBufferRef.current);
    handleGameOver();
  }, [handleGameOver]);
  // ── Main effect (Game Loop) ─────────────────────────────────
  useEffect(() => {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    audioContextRef.current = new AudioContext();

    const loadSound = async (url, bufferRef) => {
      try {
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        const decodedBuffer = await audioContextRef.current.decodeAudioData(
          arrayBuffer
        );
        bufferRef.current = decodedBuffer;
      } catch (error) {
        console.error("Error loading sound:", url, error);
      }
    };

    loadSound("/sounds/jump.m4a", jumpBufferRef);
    loadSound("/sounds/gameover.m4a", gameOverBufferRef);



    const pose = new Pose({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
    });

    pose.setOptions({
      modelComplexity: 0,
      smoothLandmarks: true,
      enableSegmentation: false,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    pose.onResults((results) => {
      const canvasCtx = canvasRef.current.getContext("2d");
      canvasCtx.clearRect(
        0,
        0,
        canvasRef.current.width,
        canvasRef.current.height
      );
      canvasCtx.drawImage(
        results.image,
        0,
        0,
        canvasRef.current.width,
        canvasRef.current.height
      );

      if (results.poseLandmarks) {
        drawConnectors(canvasCtx, results.poseLandmarks, POSE_CONNECTIONS, {
          color: "#00FF00",
          lineWidth: 4,
        });
        drawLandmarks(canvasCtx, results.poseLandmarks, {
          color: "#FF0000",
          lineWidth: 2,
        });

        const leftShoulder = results.poseLandmarks[11];
        const rightShoulder = results.poseLandmarks[12];
        const avgShoulderY = (leftShoulder.y + rightShoulder.y) / 2;

        if (prevShoulderRef.current !== null && isGameActiveRef.current) {
          const diff = prevShoulderRef.current - avgShoulderY;
          const now = Date.now();

          if (diff > 0.04 && now - lastJumpTimeRef.current > 500) {
            playSound(jumpBufferRef.current);
            simulateSpacebar();
            lastJumpTimeRef.current = now;
            jumpCountRef.current += 1;
            console.log("Jump detected!");
          }
        }

        prevShoulderRef.current = avgShoulderY;
      }
    });

    const camera = new Camera(videoRef.current, {
      onFrame: async () => {
        await pose.send({ image: videoRef.current });
      },
      width: 640,
      height: 480,
    });

    camera.start();

    return () => {

    };
  }, []);

  function playSound(buffer) {
    if (buffer && audioContextRef.current) {
      if (audioContextRef.current.state === "suspended") {
        audioContextRef.current.resume();
      }
      const source = audioContextRef.current.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContextRef.current.destination);
      source.start(0);
    }
  }

  function simulateSpacebar() {
    const downEvent = new KeyboardEvent("keydown", {
      key: " ",
      code: "Space",
      keyCode: 32,
      which: 32,
      bubbles: true,
    });
    const upEvent = new KeyboardEvent("keyup", {
      key: " ",
      code: "Space",
      keyCode: 32,
      which: 32,
      bubbles: true,
    });
    document.dispatchEvent(downEvent);
    setTimeout(() => document.dispatchEvent(upEvent), 100);
  }

  function resetLeaderboard() {
    saveStored(STORAGE_KEYS.LEADERBOARD, []);
    setLeaderboard([]);
  }

  function resetStats() {
    const empty = {
      totalJumps: 0,
      totalPlayTime: 0,
      totalScore: 0,
      roundsPlayed: 0,
    };
    saveStored(STORAGE_KEYS.SESSION_STATS, empty);
    setSessionStats(empty);
    saveStored(STORAGE_KEYS.STREAK, { current: 0, best: 0, lastScore: 0 });
    setStreak({ current: 0, best: 0, lastScore: 0 });
  }

  const avgScore =
    sessionStats.roundsPlayed > 0
      ? Math.round(sessionStats.totalScore / sessionStats.roundsPlayed)
      : 0;

  // ══════════════════════════════════════════════════════════════
  return (
    <div className={`app-container ${theme}`}>
      {/* ── Main Menu (Start Screen) ─────────────────────────── */}
      {gameState === GAME_STATE.START && (
        <div className="modal-overlay main-menu-overlay">
          <div className="modal-content main-menu-card">
            <h1 className="menu-title">JUMPING DINO 🦖</h1>
            <p className="menu-subtitle">ARCADE EDITION</p>

            <form onSubmit={handleNameSubmit}>
              <div className="input-group">
                <label>ENTER PLAYER NAME</label>
                <input
                  type="text"
                  placeholder="PLAYER ONE"
                  value={inputName}
                  onChange={(e) => setInputName(e.target.value)}
                  maxLength={10}
                  autoFocus
                />
              </div>
              <button className="start-btn pulse" type="submit" disabled={!inputName.trim()}>
                START
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ── Game Over Summary ────────────────────────────────── */}
      {gameState === GAME_STATE.GAME_OVER && (
        <div className="modal-overlay summary-overlay">
          <div className="modal-content summary-card">
            <h2>GAME OVER</h2>
            <div className="summary-stats">
              <div className="summary-row">
                <span>SCORE</span>
                <span className="summary-val highlight">{lastGameScore}</span>
              </div>
              <div className="summary-row">
                <span>JUMPS</span>
                <span className="summary-val">{jumpCountRef.current}</span>
              </div>
              <div className="summary-row">
                <span>PLAYER</span>
                <span className="summary-val">{playerName}</span>
              </div>
            </div>

            <div className="summary-actions">
              <button onClick={handleRetry} className="retry-btn">
                RETRY ↺
              </button>
              <button onClick={handleMainMenu} className="menu-btn">
                MAIN MENU 🏠
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Left Side: Game + Camera ─────────────────────────── */}
      <div className="game-area">
        <div className="camera-container">
          <video
            ref={videoRef}
            style={{ display: "none" }}
            className="videobox"
          />
          <canvas
            ref={canvasRef}
            width="200"
            height="200"
            className="canvasCam"
          />
        </div>
        <div className="game-wrapper">
          <DinoGame
            className="gameCanvas"
            onGameOver={handleCrash}
            difficulty={{
              speed: 3.5,
              acceleration: 0,
              gapCoefficient: 28.0,
              maxObstacleDuplication: 1
            }}
          />
        </div>
      </div>

      {/* ── Right Side: Sidebar ──────────────────────────────── */}
      <div className="sidebar">
        <h2 className="brand-title">Jumping Dino 🦖</h2>

        {/* Toggle Switch */}
        <div className="theme-toggle-container">
          <button className="theme-toggle" onClick={toggleTheme}>
            <span className="toggle-icon">{theme === "dark" ? "☀️" : "🌙"}</span>
            <span className="toggle-text">
              {theme === "dark" ? "Light Mode" : "Dark Mode"}
            </span>
          </button>
        </div>

        {/* Features Stack */}
        <div className="sidebar-content">
          {/* Stats Panel */}
          <div className="panel stats-panel">
            <div className="panel-header">
              <span className="panel-icon">📈</span>
              <h3>Session Stats</h3>
            </div>
            <div className="stats-grid compact">
              <div className="stat-card">
                <span className="stat-value">{sessionStats.totalJumps}</span>
                <span className="stat-label">Jumps</span>
              </div>
              <div className="stat-card">
                <span className="stat-value">
                  {formatTime(sessionStats.totalPlayTime)}
                </span>
                <span className="stat-label">Time</span>
              </div>
              <div className="stat-card">
                <span className="stat-value">{avgScore}</span>
                <span className="stat-label">Avg</span>
              </div>
              <div className="stat-card">
                <span className="stat-value">{sessionStats.roundsPlayed}</span>
                <span className="stat-label">Rounds</span>
              </div>
            </div>
            <button className="reset-btn" onClick={resetStats}>
              Reset
            </button>
          </div>

          {/* Streak Panel */}
          <div className="panel streak-panel">
            <div className="panel-header">
              <span className="panel-icon">�</span>
              <h3>Streak</h3>
            </div>
            <div className="streak-body compact">
              <div className="streak-main">
                <span className="streak-number large">{streak.current}</span>
                <span className="streak-label">Current</span>
              </div>
              <div className="streak-info">
                <div className="info-row">
                  <span>Best:</span> <strong>{streak.best}</strong>
                </div>
                {lastGameScore !== null && (
                  <div className="info-row highlight-score">
                    <span>Last:</span> <strong>{lastGameScore}</strong>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Leaderboard Panel */}
          <div className="panel leaderboard-panel">
            <div className="panel-header">
              <span className="panel-icon">🏆</span>
              <h3>Top Scores</h3>
            </div>
            {leaderboard.length === 0 ? (
              <div className="leaderboard-empty">
                <p>No scores yet.</p>
              </div>
            ) : (
              <div className="leaderboard-list compact">
                {leaderboard.map((entry, i) => (
                  <div
                    key={i}
                    className={`lb-row ${i === newHighlight ? "lb-new" : ""} ${i === 0
                      ? "lb-gold"
                      : i === 1
                        ? "lb-silver"
                        : i === 2
                          ? "lb-bronze"
                          : ""
                      }`}
                  >
                    <span className="lb-rank">{i + 1}</span>
                    <span className="lb-name">{entry.name}</span>
                    <span className="lb-score">{entry.score}</span>
                    <span className="lb-time">{timeAgo(entry.timestamp)}</span>
                  </div>
                ))}
              </div>
            )}
            {leaderboard.length > 0 && (
              <button className="reset-btn" onClick={resetLeaderboard}>
                Clear
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
