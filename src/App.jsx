import React, { useEffect, useRef, useState, useCallback } from "react";
import { Pose, POSE_CONNECTIONS } from "@mediapipe/pose";
import { drawConnectors, drawLandmarks } from "@mediapipe/drawing_utils";
import { Camera } from "@mediapipe/camera_utils";
import ChromeDinoGame from "react-chrome-dino";
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
const App = () => {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const prevShoulderRef = useRef(null);
  const lastJumpTimeRef = useRef(0);

  // Audio
  const audioContextRef = useRef(null);
  const jumpBufferRef = useRef(null);
  const gameOverBufferRef = useRef(null);

  // Stats tracking refs (non-render)
  const jumpCountRef = useRef(0);
  const roundStartRef = useRef(Date.now());

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

    setLeaderboard((prev) => {
      const entry = {
        score,
        date: Date.now(),
        jumps,
        time: Math.round(roundTime),
      };
      const updated = [...prev, entry]
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      const idx = updated.findIndex(
        (e) => e.date === entry.date && e.score === entry.score
      );
      setNewHighlight(idx);
      setTimeout(() => setNewHighlight(-1), 3000);
      saveStored(STORAGE_KEYS.LEADERBOARD, updated);
      return updated;
    });

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

    jumpCountRef.current = 0;
    roundStartRef.current = Date.now();
  }, []);

  // ── Main effect ─────────────────────────────────────────────
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

    const checkRunner = setInterval(() => {
      if (window.Runner && window.Runner.instance_) {
        const originalGameOver = window.Runner.instance_.gameOver;

        if (!window.Runner.instance_.gameOver.isPatched) {
          window.Runner.instance_.gameOver = function () {
            playSound(gameOverBufferRef.current);
            handleGameOver();
            originalGameOver.apply(this, arguments);
          };
          window.Runner.instance_.gameOver.isPatched = true;
        }

        clearInterval(checkRunner);
      }
    }, 50);

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

        if (prevShoulderRef.current !== null) {
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
      clearInterval(checkRunner);
    };
  }, [handleGameOver]);

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
          <ChromeDinoGame className="gameCanvas" />
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
                    <span className="lb-score">{entry.score}</span>
                    <span className="lb-time">{timeAgo(entry.date)}</span>
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
