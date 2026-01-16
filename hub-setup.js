import { $ } from 'zx';
import fs from 'fs';
import path from 'path';

$.verbose = true;

const RETRY_LIMIT = 5;
const RETRY_DELAY_MS = 3000; // 3 seconds delay between retries

// Get script directory - assume script runs from /data/hub-setup/media-hub-setup-main/
const SCRIPT_DIR = process.cwd();
const BASE_DIR = '/data';

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
      console.log(`Retrying in ${RETRY_DELAY_MS / 1000} seconds...`);
      await new Promise(res => setTimeout(res, RETRY_DELAY_MS));
    }
  }
}

async function checkPackageInstalled(packageName) {
  return retry(async () => {
    const result = await $`npm list -g --depth=0 | grep ${packageName}`.nothrow();
    return result.stdout.includes(packageName);
  });
}

async function checkFileExists(filePath) {
  return retry(async () => {
    const result = await $`test -f ${filePath} && echo "File exists"`.nothrow();
    return result.stdout.includes("File exists");
  });
}

async function execCommandWithRetries(command, cwd = null) {
  return retry(async () => {
    // Use sh -c for shell commands to properly handle pipes, redirects, etc.
    // This ensures the command is executed as a shell command, not as a single argument
    let result;
    if (cwd) {
      const fullCommand = `cd ${cwd} && ${command}`;
      result = await $`sh -c ${fullCommand}`.nothrow();
    } else {
      result = await $`sh -c ${command}`.nothrow();
    }

    if (result.stderr && result.exitCode !== 0) {
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
    const result = await $`podman network ls --format "{{.Name}}"`.nothrow();
    const networks = result.stdout.split('\n').filter(n => n.trim());

    if (networks.includes(networkName)) {
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
    console.log('Starting hub setup...');
    console.log(`Script directory: ${SCRIPT_DIR}`);

    // Check if npm is installed
    const npmCheck = await $`npm --version`.nothrow();
    if (npmCheck.exitCode !== 0) {
      console.error('NPM is not installed. Exiting.');
      return;
    }
    console.log(`NPM version: ${npmCheck.stdout.trim()}`);

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

    // Check for files in script directory or current directory
    // Files should be downloaded from GitHub to the script directory
    const nodeManagerTarPath = path.join(SCRIPT_DIR, 'node-manager-1.0.0.tar.gz');
    const podmanApiPath = path.join(SCRIPT_DIR, 'index-linux-arm64');
    const ecosystemConfigPath = path.join(SCRIPT_DIR, 'ecosystem.config.js');

    // Check if files exist locally, if not, they should be in the repo
    let nodeManagerSource = nodeManagerTarPath;
    let podmanApiSource = podmanApiPath;
    let ecosystemConfigSource = ecosystemConfigPath;

    // If files don't exist in script dir, check current directory
    if (!fs.existsSync(nodeManagerTarPath)) {
      nodeManagerSource = './node-manager-1.0.0.tar.gz';
    }
    if (!fs.existsSync(podmanApiPath)) {
      podmanApiSource = './index-linux-arm64';
    }
    if (!fs.existsSync(ecosystemConfigPath)) {
      ecosystemConfigSource = './ecosystem.config.js';
    }

    // Copy files to target locations
    if (fs.existsSync(nodeManagerSource)) {
      console.log('Node Manager tarball found. Copying...');
      await $`cp ${nodeManagerSource} /data/keus-iot-platform/node-manager-1.0.0.tar.gz`;
    } else {
      console.log('Warning: Node Manager tarball not found. Skipping...');
    }

    if (fs.existsSync(podmanApiSource)) {
      console.log('Podman API binary found. Copying...');
      await $`cp ${podmanApiSource} /usr/bin/podman-remote-api`;
      await execCommandWithRetries('chmod +x /usr/bin/podman-remote-api');
    } else {
      console.log('Warning: Podman API binary not found. Skipping...');
    }

    const tarFilePath = '/data/keus-iot-platform/node-manager-1.0.0.tar.gz';
    if (fs.existsSync(tarFilePath) || await checkFileExists(tarFilePath)) {
      // Extract Node Manager
      console.log('Extracting Node Manager...');
      await execCommandWithRetries('tar -xvzf node-manager-1.0.0.tar.gz', '/data/keus-iot-platform');
    } else {
      console.log('Warning: Node Manager tar file not found. Skipping extraction...');
    }

    // Check if Podman is installed
    const podmanCheck = await $`podman --version`.nothrow();
    if (podmanCheck.exitCode !== 0 || !podmanCheck.stdout.includes('podman')) {
      throw new Error('Podman is not installed. Please install Podman before proceeding.');
    }
    console.log(`Podman version: ${podmanCheck.stdout.trim()}`);

    // Create Podman network
    await createNetworkIfNotExists('kiotp-network');

    // PM2 setup
    console.log('Setting up PM2...');
    await execCommandWithRetries('pm2 startup');
    await execCommandWithRetries('systemctl enable pm2-root');
    await execCommandWithRetries('pm2 save --force');
    await execCommandWithRetries('pm2 install pm2-logrotate');

    // Copy PM2 config and start
    if (fs.existsSync(ecosystemConfigSource)) {
      console.log('Copying PM2 config...');
      await $`cp ${ecosystemConfigSource} /data/ecosystem.config.js`;
      await execCommandWithRetries('pm2 start ecosystem.config.js', '/data');
      await execCommandWithRetries('pm2 save --force');
    } else {
      console.log('Warning: ecosystem.config.js not found. Skipping PM2 start...');
    }

    console.log('Hub setup completed successfully!');

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
})();
