const fs = require('fs');
const path = require('path');

const venvPython = path.resolve(__dirname, '.venv', 'Scripts', 'python.exe');
const pythonInterpreter = fs.existsSync(venvPython) ? venvPython : 'python';

const apps = [
  {
    name: 'streetverse-gateway',
    cwd: path.resolve(__dirname, 'services', 'api-gateway'),
    script: 'dist/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 5000,
    },
  },
  {
    name: 'streetverse-ai-engine',
    cwd: path.resolve(__dirname, 'services', 'ai-agent-engine'),
    script: 'main.py',
    interpreter: pythonInterpreter,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
  },
];

// If ngrok is installed, keep the public tunnel online 24/7 via PM2
const ngrokExe = 'C:\\Windows\\ngrok.exe';
if (fs.existsSync(ngrokExe)) {
  apps.push({
    name: 'streetverse-tunnel',
    script: ngrokExe,
    args: 'http 5000 --url https://clatter-mousiness-smugness.ngrok-free.dev --log=stdout',
    autorestart: true,
    watch: false,
  });
}

module.exports = { apps };
