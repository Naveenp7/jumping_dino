import React, { useEffect } from 'react';
import ChromeDinoGame from 'react-chrome-dino';

const DinoGame = ({
    onGameOver,
    difficulty = {
        speed: 10,
        acceleration: 0.0001,
        gapCoefficient: 1.0,
        maxObstacleDuplication: 1
    }
}) => {
    useEffect(() => {
        // We check periodically until the Runner instance is available
        const checkRunner = setInterval(() => {
            // Access the global Runner instance from react-chrome-dino
            if (window.Runner && window.Runner.instance_) {
                const runner = window.Runner.instance_;
                const config = window.Runner.config;

                // Patch gameOver if not already patched
                if (!runner.gameOver.isPatched) {
                    const originalGameOver = runner.gameOver;
                    runner.gameOver = function () {
                        // Trigger the parent's callback (e.g., play sound, save score)
                        if (onGameOver) onGameOver();

                        // Call the original gameOver logic
                        originalGameOver.apply(this, arguments);
                    };
                    runner.gameOver.isPatched = true;

                    // ── Apply Difficulty Settings ──────────────────────────
                    // Speed
                    runner.setSpeed(difficulty.speed);
                    config.SPEED = difficulty.speed;

                    // Acceleration
                    config.ACCELERATION = difficulty.acceleration;

                    // Obstacle Gaps (Higher = easier/fewer obstacles)
                    config.GAP_COEFFICIENT = difficulty.gapCoefficient;

                    // Max duplicate obstacles (Limit to 1 for easier gameplay)
                    config.MAX_OBSTACLE_DUPLICATION = difficulty.maxObstacleDuplication;
                }

                clearInterval(checkRunner);
            }
        }, 50);

        return () => clearInterval(checkRunner);
    }, [onGameOver, difficulty]);

    return <ChromeDinoGame className="gameCanvas" />;
};

export default DinoGame;
