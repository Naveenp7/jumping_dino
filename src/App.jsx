import React, { useEffect, useRef } from "react";
import { Pose } from "@mediapipe/pose";
import { Camera } from "@mediapipe/camera_utils";
import ChromeDinoGame from "react-chrome-dino";
import "./App.css";

const App = () => {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const prevShoulderRef = useRef(null);
  const lastJumpTimeRef = useRef(0);

  // Use AudioContext for low latency
  const audioContextRef = useRef(null);
  const jumpBufferRef = useRef(null);
  const gameOverBufferRef = useRef(null);

  useEffect(() => {
    window.focus(); // ensure window is focused for key events

    // Initialize AudioContext
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    audioContextRef.current = new AudioContext();

    // Helper to load buffer
    const loadSound = async (url, bufferRef) => {
      try {
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        const decodedBuffer = await audioContextRef.current.decodeAudioData(arrayBuffer);
        bufferRef.current = decodedBuffer;
      } catch (error) {
        console.error("Error loading sound:", url, error);
      }
    };

    loadSound("/sounds/jump.mp4", jumpBufferRef);
    loadSound("/sounds/gameover.mp4", gameOverBufferRef);

    // Hook into the Dino game runner for Game Over detection
    // Polling faster (50ms) to ensure we hook immediately on game load
    const checkRunner = setInterval(() => {
      if (window.Runner && window.Runner.instance_) {
        const originalGameOver = window.Runner.instance_.gameOver;

        // Ensure we don't double-patch
        if (!window.Runner.instance_.gameOver.isPatched) {
          window.Runner.instance_.gameOver = function () {
            playSound(gameOverBufferRef.current);
            originalGameOver.apply(this, arguments);
          };
          window.Runner.instance_.gameOver.isPatched = true;
        }

        clearInterval(checkRunner);
      }
    }, 50);

    // Pose setup
    const pose = new Pose({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
    });

    pose.setOptions({
      modelComplexity: 0, // Using 0 (Lite) for better performance/smoothness
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
        const leftShoulder = results.poseLandmarks[11];
        const rightShoulder = results.poseLandmarks[12];
        const avgShoulderY = (leftShoulder.y + rightShoulder.y) / 2;

        if (prevShoulderRef.current !== null) {
          const diff = prevShoulderRef.current - avgShoulderY;
          const now = Date.now();

          // Jump threshold and cooldown (500ms)
          if (diff > 0.04 && now - lastJumpTimeRef.current > 500) {
            playSound(jumpBufferRef.current); // Play sound immediately on detection
            simulateSpacebar();
            lastJumpTimeRef.current = now;
            console.log("Jump detected!");
          }
        }

        prevShoulderRef.current = avgShoulderY;
      }
    });

    // Start the camera
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
  }, []);

  function playSound(buffer) {
    if (buffer && audioContextRef.current) {
      // Resume context if suspended (browser autoplay policy)
      if (audioContextRef.current.state === 'suspended') {
        audioContextRef.current.resume();
      }
      const source = audioContextRef.current.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContextRef.current.destination);
      source.start(0);
    }
  }

  // Function to simulate spacebar press
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
    setTimeout(() => {
      document.dispatchEvent(upEvent);
    }, 100);
  }

  return (
    <>
      <div className="flex-center">
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
      <ChromeDinoGame className="gameCanvas" />
      <div className="banner">
      </div>
    </>
  );
};

export default App;
