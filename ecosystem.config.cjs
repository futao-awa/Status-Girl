module.exports = {
  apps: [{
    name: 'status-girl',
    script: 'server.js',
    instances: 1,
    exec_mode: 'fork',
    env: { NODE_ENV: 'production', PORT: 3000 }
  }]
};
