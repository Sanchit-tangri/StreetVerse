module.exports = {
  apps: [
    {
      name: 'streetverse-gateway',
      cwd: './services/api-gateway',
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
      cwd: './services/ai-agent-engine',
      script: 'main.py',
      interpreter: 'python',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
    },
  ],
};
