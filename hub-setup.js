import { $ } from 'zx';
import { NodeSSH } from 'node-ssh';
import fs from 'fs';
import path from 'path';

$.verbose = true;

const ssh = new NodeSSH();
const MEDIA_HUB_IP = '10.1.4.215';
const RETRY_LIMIT = 5;
const RETRY_DELAY_MS = 3000; // 3 seconds delay between retries

async function reconnectIfNeeded() {
  if (!ssh.isConnected()) {
    console.log('SSH connection lost. Attempting to reconnect...');
    await connectToRaspberryPi();
  }
}

async function retry(fn, retries = RETRY_LIMIT) {
  let attempts = 0;
  while (attempts < retries) {
    try {
      return await fn();
    } catch (error) {
      attempts++;
      console.error(`Error occurred on attempt ${attempts}:`, error);
      if (attempts >= retries) {
        console.error('Max retry limit reached. Exiting.');
        throw error;
      }
      // Check if the connection is lost and reconnect
      await reconnectIfNeeded();  // Check if the connection is still active before retrying
      console.log(`Retrying in ${RETRY_DELAY_MS / 1000} seconds...`);
      await new Promise(res => setTimeout(res, RETRY_DELAY_MS));
    }
  }
}

async function connectToRaspberryPi() {
  return retry(async () => {
    console.log(`Connecting to Raspberry Pi at ${MEDIA_HUB_IP}...`);
    await ssh.connect({
      host: MEDIA_HUB_IP,
      username: 'root',
      password: 'keus123',
    });
    console.log('Successfully connected to Raspberry Pi');
  });
}

async function checkPackageInstalled(packageName) {
  return retry(async () => {
    const result = await ssh.execCommand(`npm list -g --depth=0 | grep ${packageName}`);
    return result.stdout.includes(packageName);
  });
}

async function checkFileExists(remotePath) {
  return retry(async () => {
    const result = await ssh.execCommand(`test -f ${remotePath} && echo "File exists"`);
    return result.stdout.includes("File exists");
  });
}

async function uploadFile(localPath, remotePath) {
  return retry(async () => {
    console.log(`Uploading file from ${localPath} to ${remotePath}...`);
    if (!fs.existsSync(localPath)) {
      throw new Error(`Local file does not exist: ${localPath}`);
    }
    await $`scp ${localPath} root@${MEDIA_HUB_IP}:${remotePath}`;
    console.log('File uploaded successfully');
  });
}

async function execCommandWithRetries(command, cwd = null) {
  return retry(async () => {
    const result = await ssh.execCommand(command, { cwd });
    if (result.stderr) {
      throw new Error(result.stderr);
    }
    return result.stdout;
  });
}

async function buildNodeManager() {
  try {
    await $`node /keus-iot-platform/tools/platform-node-starter/prod/esbuild.mjs`;
  } catch (error) {
    console.error('Failed to build Node Manager. Exiting.');
    return;
  }
}

async function buildPodmanRemoteApi() {
  try {
    await $`pnpm run -C /keus-iot-platform/libs/podman-remote-api build-prod-service`;
    await $`pnpm run -C /keus-iot-platform/libs/podman-remote-api build-ts`;
    await $`npm i -g pkg`;
    await $`pnpm run -C /keus-iot-platform/libs/podman-remote-api generate-binaries-prod-service`;
  } catch (error) {
    console.error('Failed to build Podman Remote Api. Exiting.');
    return;
  }
}

async function createNetworkIfNotExists(networkName) {
  try {
    // Check if network already exists
    const existingNetworks = await ssh.execCommand('podman network ls --format "{{.Name}}"');

    if (existingNetworks.stdout.split('\n').includes(networkName)) {
      console.log(`Network "${networkName}" already exists.`);
    } else {
      // If the network doesn't exist, create it
      console.log(`Creating network "${networkName}"...`);
      await execCommandWithRetries(`podman network create ${networkName}`);
      console.log(`Network "${networkName}" created successfully.`);
    }
  } catch (error) {
    console.error(`Failed to create or check network: ${error}`);
  }
}



(async () => {
  try {
    await connectToRaspberryPi();
    await $`ssh root@${MEDIA_HUB_IP} ls`

    // Check if npm is installed
    if (!await checkPackageInstalled('npm')) {
      console.error('NPM is not installed. Exiting.');
      return;
    }

    // Install packages if not already installed
    if (!await checkPackageInstalled('pm2')) {
      console.log('Installing PM2...');
      await execCommandWithRetries('npm i -g pm2');
    } else {
      console.log('PM2 is already installed.');
    }

    if (!await checkPackageInstalled('zx')) {
      console.log('Installing ZX...');
      await execCommandWithRetries('npm i -g zx');
    } else {
      console.log('ZX is already installed.');
    }

    // Create necessary directories
    await execCommandWithRetries('mkdir -p /data/keus-iot-platform/logs');
    await execCommandWithRetries('mkdir -p /data/keus-iot-platform/plugins');

    // Check and upload files
    const nodeManagerTarPath = './node-manager-1.0.0.tar.gz';
    const podmanApiPath = './index-linux-arm64';

    console.log('Node Manager tarball found locally. Proceeding with upload...');
    await uploadFile(nodeManagerTarPath, '/data/keus-iot-platform/node-manager-1.0.0.tar.gz');

    console.log('Podman API binary found locally. Proceeding with upload...');
    await uploadFile(podmanApiPath, '/data/podman-remote-api');
    await execCommandWithRetries('mv /data/podman-remote-api /usr/bin/podman-remote-api');

    const tarFilePath = '/data/keus-iot-platform/node-manager-1.0.0.tar.gz';
    if (!await checkFileExists(tarFilePath)) {
      throw new Error(`Tar file does not exist on the remote server: ${tarFilePath}`);
    }

    // Extract Node Manager
    await execCommandWithRetries('tar -xvzf node-manager-1.0.0.tar.gz', '/data/keus-iot-platform');

    // Set permissions
    await execCommandWithRetries('chmod +x /usr/bin/podman-remote-api');

    // Check if Podman is installed
    const podmanCheck = await execCommandWithRetries('podman --version');
    if (!podmanCheck.includes('podman')) {
      throw new Error('Podman is not installed. Please install Podman before proceeding.');
    }

    // Create Podman network
    await createNetworkIfNotExists('kiotp-network');

    // Modify storage configuration
    // await execCommandWithRetries(`
    //   echo "Modifying graphroot in /etc/containers/storage.conf...";
    //   NEW_GRAPHROOT="/data/containers/storage";
    //   STORAGE_CONF="/etc/containers/storage.conf";
    //   sed -i "s|^graphroot =.*|graphroot = \\"$NEW_GRAPHROOT\\"|g" "$STORAGE_CONF";
    //   mkdir -p "$NEW_GRAPHROOT";
    //   chown -R root:root "$NEW_GRAPHROOT";
    //   chmod -R 755 "$NEW_GRAPHROOT";
    //   systemctl restart podman
    // `);

    // PM2 setup
    await execCommandWithRetries('pm2 startup');
    await execCommandWithRetries('systemctl enable pm2-root');
    await execCommandWithRetries('pm2 save --force');
    await execCommandWithRetries('pm2 install pm2-logrotate');

    // Upload PM2 config and start
    await uploadFile('./ecosystem.config.js', '/data/ecosystem.config.js');
    await execCommandWithRetries('pm2 start ecosystem.config.js', '/data');
    await execCommandWithRetries('pm2 save --force');

  } catch (error) {
    console.error('Error:', error);
  } finally {
    ssh.dispose();
  }
})();
