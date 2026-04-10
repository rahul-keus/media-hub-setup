#!/bin/bash
set -e

RETRY_LIMIT=5
RETRY_DELAY=3

BASE_DIR="/data"
PLATFORM_DIR="${BASE_DIR}/keus-iot-platform"
TAR_URL="https://keus-resources.s3.ap-south-1.amazonaws.com/keus-iot-platform/keus-iot-platform.tar.gz"
TAR_PATH="${BASE_DIR}/keus-iot-platform.tar.gz"

log_progress() {
  echo "PROGRESS:$1:$2"
}

retry() {
  local attempts=0
  local cmd="$*"
  while [ $attempts -lt $RETRY_LIMIT ]; do
    if eval "$cmd"; then
      return 0
    fi
    attempts=$((attempts + 1))
    echo "Error on attempt ${attempts}"
    if [ $attempts -ge $RETRY_LIMIT ]; then
      echo "Max retry limit reached. Exiting."
      return 1
    fi
    echo "Retrying in ${RETRY_DELAY} seconds..."
    sleep $RETRY_DELAY
  done
}

# Step 1: Check if pm2 and zx are installed, install if missing
check_and_install_dependencies() {
  if ! command -v npm &>/dev/null; then
    echo "NPM is not installed. Exiting."
    exit 1
  fi
  echo "NPM version: $(npm --version)"

  if ! npm list -g --depth=0 2>/dev/null | grep -q pm2; then
    echo "Installing PM2..."
    log_progress 10 "Installing PM2"
    retry npm i -g pm2
  else
    echo "PM2 is already installed."
    log_progress 10 "PM2 already installed"
  fi

  if ! npm list -g --depth=0 2>/dev/null | grep -q zx; then
    echo "Installing ZX..."
    log_progress 15 "Installing ZX"
    retry npm i -g zx
  else
    echo "ZX is already installed."
    log_progress 15 "ZX already installed"
  fi
}

# Step 2: Download the platform tar from S3
# NOTE: You can comment out the call to this function and manually place
# keus-iot-platform.tar.gz in /data — the rest of the setup will still work.
download_platform_tar() {
  echo "Downloading keus-iot-platform.tar.gz from S3..."
  log_progress 25 "Downloading platform tar"
  retry curl -fSL -o "$TAR_PATH" "$TAR_URL"
  echo "Download complete."
}

# Step 3: Extract the tar in /data
# Extracts ecosystem.config.js and keus-iot-platform/ into /data
extract_platform_tar() {
  if [ ! -f "$TAR_PATH" ]; then
    echo "Tar file not found at ${TAR_PATH}. Download it first or place it manually."
    exit 1
  fi
  echo "Extracting keus-iot-platform.tar.gz into /data..."
  log_progress 40 "Extracting platform tar"
  retry tar -xvzf "$TAR_PATH" -C "$BASE_DIR"
  echo "Extraction complete."
}

# Step 4: Create required directories
create_directories() {
  echo "Creating required directories..."
  log_progress 50 "Creating directories"
  mkdir -p "${PLATFORM_DIR}/logs"
  mkdir -p "${PLATFORM_DIR}/plugins"
  echo "Directories created."
}

# Step 5: Set permissions
set_permissions() {
  echo "Setting permissions..."
  log_progress 60 "Setting permissions"
  chmod +x "${PLATFORM_DIR}/podman-remote-api"
  echo "Permissions set."
}

# Step 6: Check Podman and create network
setup_podman() {
  log_progress 70 "Checking Podman installation"
  if ! command -v podman &>/dev/null; then
    echo "Podman is not installed. Please install Podman before proceeding."
    exit 1
  fi
  echo "Podman version: $(podman --version)"

  log_progress 75 "Creating Podman network"
  if podman network ls --format "{{.Name}}" | grep -q "^kiotp-network$"; then
    echo 'Network "kiotp-network" already exists.'
  else
    echo 'Creating network "kiotp-network"...'
    retry podman network create kiotp-network
    echo 'Network "kiotp-network" created successfully.'
  fi
}

# Step 7: Start PM2 services
start_services() {
  echo "Starting PM2 services..."
  log_progress 85 "Starting PM2 services"

  if [ ! -f "${BASE_DIR}/ecosystem.config.js" ]; then
    echo "ecosystem.config.js not found at ${BASE_DIR}/ecosystem.config.js"
    exit 1
  fi

  cd "$BASE_DIR"
  retry PM2_HOME=/data/pm2 pm2 start ecosystem.config.js
  retry PM2_HOME=/data/pm2 pm2 save --force
  echo "PM2 services started."
}

# Main
echo "Starting hub setup..."
log_progress 5 "Starting hub setup"

check_and_install_dependencies

# NOTE: Comment out download_platform_tar if you want to manually place
# keus-iot-platform.tar.gz in /data and skip the download step.
download_platform_tar

extract_platform_tar
create_directories
set_permissions
setup_podman
start_services

log_progress 100 "Hub setup completed"
echo "Hub setup completed successfully!"
