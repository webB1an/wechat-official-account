module.exports = {
  apps: [
    {
      name: 'wechat-official-account',
      script: 'api/server.mjs',
      cwd: __dirname,
      interpreter: 'node',
      node_args: '--no-warnings',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
