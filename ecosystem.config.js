module.exports = {
    apps: [
      {
        name: 'node-manager-agent',  
        script: '/data/keus-iot-platform/starter-scripts/start.mjs',  
        interpreter: 'node',  
        autorestart: true,  
        env: {
          NODE_ENV: 'production',  
        },
      },
      {
        name: 'podman-remote-api',  
        script: '/usr/bin/podman-remote-api', 
        watch: false,  
        autorestart: true
      },
    ],
  };
  