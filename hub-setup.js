import { $ } from 'zx';
import fs from 'fs';

$.verbose = true;

function logProgress(percentage, message) {
  console.log(`PROGRESS:${percentage}:${message}`);
}

const RETRY_LIMIT = 5;
const RETRY_DELAY_MS = 3000;

const BASE_DIR = '/data';
const PLATFORM_DIR = `${BASE_DIR}/keus-iot-platform`;
const TAR_URL = 'https://keus-resources.s3.ap-south-1.amazonaws.com/keus-iot-platform/keus-iot-platform.tar.gz';
const TAR_PATH = `${BASE_DIR}/keus-iot-platform.tar.gz`;

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

async function execCommandWithRetries(command, cwd = null) {
  return retry(async () => {
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

async function createNetworkIfNotExists(networkName) {
  try {
    const result = await $`podman network ls --format "{{.Name}}"`.nothrow();
    const networks = result.stdout.split('\n').filter(n => n.trim());

    if (networks.includes(networkName)) {
      console.log(`Network "${networkName}" already exists.`);
    } else {
      console.log(`Creating network "${networkName}"...`);
      await execCommandWithRetries(`podman network create ${networkName}`);
      console.log(`Network "${networkName}" created successfully.`);
    }
  } catch (error) {
    console.error(`Failed to create or check network: ${error}`);
  }
}

// Step 1: Check if pm2 and zx are installed, install if missing
async function checkAndInstallDependencies() {
  const npmCheck = await $`npm --version`.nothrow();
  if (npmCheck.exitCode !== 0) {
    throw new Error('NPM is not installed. Exiting.');
  }
  console.log(`NPM version: ${npmCheck.stdout.trim()}`);

  if (!await checkPackageInstalled('pm2')) {
    console.log('Installing PM2...');
    logProgress(10, 'Installing PM2');
    await execCommandWithRetries('npm i -g pm2');
  } else {
    console.log('PM2 is already installed.');
    logProgress(10, 'PM2 already installed');
  }

  if (!await checkPackageInstalled('zx')) {
    console.log('Installing ZX...');
    logProgress(15, 'Installing ZX');
    await execCommandWithRetries('npm i -g zx');
  } else {
    console.log('ZX is already installed.');
    logProgress(15, 'ZX already installed');
  }
}

// Step 2: Download the platform tar from S3
// NOTE: You can comment out the call to this function and manually place
// keus-iot-platform.tar.gz in /data — the rest of the setup will still work.
async function downloadPlatformTar() {
  console.log('Downloading keus-iot-platform.tar.gz from S3...');
  logProgress(25, 'Downloading platform tar');
  await execCommandWithRetries(`curl -fSL -o ${TAR_PATH} "${TAR_URL}"`);
  console.log('Download complete.');
}

// Step 3: Extract the tar in /data
// Extracts ecosystem.config.js and keus-iot-platform/ into /data
async function extractPlatformTar() {
  if (!fs.existsSync(TAR_PATH)) {
    throw new Error(`Tar file not found at ${TAR_PATH}. Download it first or place it manually.`);
  }
  console.log('Extracting keus-iot-platform.tar.gz into /data...');
  logProgress(40, 'Extracting platform tar');
  await execCommandWithRetries(`tar -xvzf ${TAR_PATH} -C ${BASE_DIR}`);
  console.log('Extraction complete.');
}

// Step 4: Create required directories
async function createDirectories() {
  console.log('Creating required directories...');
  logProgress(50, 'Creating directories');
  await execCommandWithRetries(`mkdir -p ${PLATFORM_DIR}/logs`);
  await execCommandWithRetries(`mkdir -p ${PLATFORM_DIR}/plugins`);
  console.log('Directories created.');
}

// Step 5: Set permissions
async function setPermissions() {
  console.log('Setting permissions...');
  logProgress(60, 'Setting permissions');
  await execCommandWithRetries(`chmod +x ${PLATFORM_DIR}/podman-remote-api`);
  console.log('Permissions set.');
}

// Step 6: Check Podman and create network
async function setupPodman() {
  logProgress(70, 'Checking Podman installation');
  const podmanCheck = await $`podman --version`.nothrow();
  if (podmanCheck.exitCode !== 0 || !podmanCheck.stdout.includes('podman')) {
    throw new Error('Podman is not installed. Please install Podman before proceeding.');
  }
  console.log(`Podman version: ${podmanCheck.stdout.trim()}`);

  logProgress(75, 'Creating Podman network');
  await createNetworkIfNotExists('kiotp-network');
}

// Step 7: Start PM2 services
async function startServices() {
  console.log('Starting PM2 services...');
  logProgress(85, 'Starting PM2 services');

  const ecosystemPath = `${BASE_DIR}/ecosystem.config.js`;
  if (!fs.existsSync(ecosystemPath)) {
    throw new Error(`ecosystem.config.js not found at ${ecosystemPath}`);
  }

  await execCommandWithRetries('pm2 start ecosystem.config.js', BASE_DIR);
  await execCommandWithRetries('pm2 save --force');
  console.log('PM2 services started.');
}

(async () => {
  try {
    console.log('Starting hub setup...');
    logProgress(5, 'Starting hub setup');

    await checkAndInstallDependencies();

    // NOTE: Comment out downloadPlatformTar() if you want to manually place
    // keus-iot-platform.tar.gz in /data and skip the download step.
    await downloadPlatformTar();

    await extractPlatformTar();
    await createDirectories();
    await setPermissions();
    await setupPodman();
    await startServices();

    logProgress(100, 'Hub setup completed');
    console.log('Hub setup completed successfully!');

  } catch (error) {
    console.log(`PROGRESS:ERROR:${error.message}`);
    console.error('Error:', error);
    process.exit(1);
  }
})();
